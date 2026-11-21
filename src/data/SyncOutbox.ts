import AsyncStorage from '@react-native-async-storage/async-storage';
import { createHlc, hlcNow, hlcReceive, serializeHlc, type HlcTimestamp } from '../domain/hlc';
import { TRIP_STATUS_ORDINAL, type TripStatus } from '../domain/entities/TripStatus';
import { mergeTripStatus, transitionTripStatus as applyTripTransition } from '../domain/usecases/transitionTripStatus';

const STORAGE_KEY = '@uber-edgeai/sync-state-v1';
const CLOCK_SKEW_WARNING_MS = 60_000;

export interface SyncOperation {
  opId: string;
  entity: 'trip';
  entityId: string;
  field: 'status';
  crdt: 'max_ordinal';
  value: { status: string; ordinal: number };
  hlc: string;
  vclock: Record<string, number>;
}

export interface SyncRequest {
  sinceServerVersion: number;
  clientClock: Record<string, number>;
  ops: SyncOperation[];
}

export interface SyncReceipt {
  accepted: string[];
  rejected: Array<{ opId: string; reason: string }>;
  serverVersion: number;
  serverClock?: Record<string, number>;
  changes?: Array<{ hlc: string }>;
  mergedState?: Record<string, Record<string, Record<string, { status?: unknown }>>>;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface PersistedState {
  nodeId: string;
  hlc: HlcTimestamp;
  serverVersion: number;
  vclock: Record<string, number>;
  outbox: SyncOperation[];
  tripStatuses: Record<string, TripStatus>;
}

const initialState = (): PersistedState => {
  const nodeId = `driver_${randomHex(12)}`;
  return {
    nodeId,
    hlc: createHlc(nodeId, Date.now()),
    serverVersion: 0,
    vclock: { [nodeId]: 0, server: 0 },
    outbox: [],
    tripStatuses: {},
  };
};

export class SyncOutbox {
  constructor(
    private readonly storage: KeyValueStorage = AsyncStorage,
    private readonly wallClock: () => number = Date.now,
    private readonly onClockSkew: (skewMs: number) => void = skewMs => {
      console.warn(`Gateway clock is ${Math.round(skewMs / 1000)}s ahead of this device`);
    },
  ) {}

  async getTripStatus(tripId: string): Promise<TripStatus> {
    const state = await this.load();
    return state.tripStatuses[tripId] ?? 'EN_ROUTE_TO_PICKUP';
  }

  async transitionTripStatus(
    tripId: string,
    nextStatus: TripStatus,
  ): Promise<TripStatus | null> {
    const state = await this.load();
    const current = state.tripStatuses[tripId] ?? 'EN_ROUTE_TO_PICKUP';
    const transitioned = applyTripTransition(current, nextStatus);
    if (!transitioned) return null;
    if (transitioned === current) return current;

    const now = this.wallClock();
    state.hlc = hlcNow(state.hlc, now);
    state.vclock[state.nodeId] = (state.vclock[state.nodeId] ?? 0) + 1;
    const operation: SyncOperation = {
      opId: createUuidV7(now),
      entity: 'trip',
      entityId: tripId,
      field: 'status',
      crdt: 'max_ordinal',
      value: { status: transitioned, ordinal: TRIP_STATUS_ORDINAL[transitioned] },
      hlc: serializeHlc(state.hlc),
      vclock: { ...state.vclock },
    };
    state.outbox.push(operation);
    state.tripStatuses[tripId] = transitioned;
    await this.save(state);
    return transitioned;
  }

  async createRequest(): Promise<SyncRequest> {
    const state = await this.load();
    return {
      sinceServerVersion: state.serverVersion,
      clientClock: { ...state.vclock },
      ops: [...state.outbox],
    };
  }

  async applyReceipt(receipt: SyncReceipt): Promise<void> {
    const state = await this.load();
    const accepted = new Set(receipt.accepted);
    state.outbox = state.outbox.filter(operation => !accepted.has(operation.opId));
    state.serverVersion = Math.max(state.serverVersion, receipt.serverVersion);
    if (receipt.serverClock) {
      for (const [nodeId, counter] of Object.entries(receipt.serverClock)) {
        state.vclock[nodeId] = Math.max(state.vclock[nodeId] ?? 0, counter);
      }
    }
    for (const change of receipt.changes ?? []) {
      const remoteHlc = parseHlc(change.hlc);
      const result = hlcReceive(state.hlc, remoteHlc, this.wallClock());
      state.hlc = result.timestamp;
      if (result.clockSkewMs > CLOCK_SKEW_WARNING_MS) this.onClockSkew(result.clockSkewMs);
    }
    for (const [tripId, trip] of Object.entries(receipt.mergedState?.trip ?? {})) {
      const remoteStatus = trip.status?.status;
      if (!isTripStatus(remoteStatus)) continue;
      const localStatus = state.tripStatuses[tripId] ?? 'EN_ROUTE_TO_PICKUP';
      state.tripStatuses[tripId] = mergeTripStatus(localStatus, remoteStatus);
    }
    await this.save(state);
  }

  async getPendingCount(): Promise<number> {
    return (await this.load()).outbox.length;
  }

  private async load(): Promise<PersistedState> {
    const raw = await this.storage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    try {
      const state = JSON.parse(raw) as PersistedState;
      if (!state.nodeId || !state.hlc || !Array.isArray(state.outbox)) throw new Error('invalid state');
      return { ...state, tripStatuses: state.tripStatuses ?? {} };
    } catch {
      // Corrupt persisted state should not block the driver from using the app.
      return initialState();
    }
  }

  private async save(state: PersistedState): Promise<void> {
    await this.storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

function parseHlc(value: string): HlcTimestamp {
  const [physical, counter, ...nodeParts] = value.split(':');
  if (!physical || !counter || nodeParts.length === 0) throw new TypeError('Invalid HLC returned by gateway');
  return {
    physicalMs: Number(physical),
    logicalCounter: Number.parseInt(counter, 16),
    nodeId: nodeParts.join(':'),
  };
}

function createUuidV7(timestamp: number): string {
  const time = timestamp.toString(16).padStart(12, '0').slice(-12);
  const random = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  const variant = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)];
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random().slice(1)}-${variant}${random().slice(1)}-${random()}${random()}${random()}`;
}

function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function isTripStatus(value: unknown): value is TripStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRIP_STATUS_ORDINAL, value);
}
