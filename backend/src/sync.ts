import { z } from 'zod';

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const syncOperationSchema = z.object({
  opId: z.string().regex(uuidV7, 'opId must be a UUIDv7'),
  entity: z.string().min(1).max(80),
  entityId: z.string().min(1).max(128),
  field: z.string().min(1).max(80),
  crdt: z.enum(['lww', 'max_ordinal', 'or_set_add', 'or_set_remove']),
  value: z.record(z.string(), z.unknown()),
  hlc: z.string().regex(/^\d+:[0-9a-fA-F]{4,}:[^:]+$/).max(128).refine(value => {
    const [physical, counter] = value.split(':');
    return Number.isSafeInteger(Number(physical)) && Number.isSafeInteger(Number.parseInt(counter ?? '', 16));
  }, 'hlc timestamp and counter must be safe integers'),
  vclock: z.record(z.string(), z.number().int().nonnegative()),
}).superRefine((operation, context) => {
  if (operation.crdt === 'max_ordinal') {
    const ordinal = operation.value.ordinal;
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) {
      context.addIssue({ code: 'custom', path: ['value', 'ordinal'], message: 'max_ordinal requires a non-negative integer ordinal' });
    }
  }
  if (operation.crdt === 'or_set_add' && (typeof operation.value.tag !== 'string' || typeof operation.value.text !== 'string')) {
    context.addIssue({ code: 'custom', path: ['value'], message: 'or_set_add requires string tag and text values' });
  }
  if (operation.crdt === 'or_set_remove' && (!Array.isArray(operation.value.tags) || operation.value.tags.some(tag => typeof tag !== 'string'))) {
    context.addIssue({ code: 'custom', path: ['value', 'tags'], message: 'or_set_remove requires a string tags array' });
  }
});

export const syncRequestSchema = z.object({
  sinceServerVersion: z.number().int().nonnegative(),
  clientClock: z.record(z.string(), z.number().int().nonnegative()),
  ops: z.array(syncOperationSchema).max(200),
});

export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export interface SyncResult {
  accepted: string[];
  rejected: Array<{ opId: string; reason: string }>;
  serverVersion: number;
  serverClock: Record<string, number>;
  changes: SyncChange[];
  mergedState: Record<string, unknown>;
}

export interface SyncChange {
  entity: string;
  entityId: string;
  field: string;
  crdt: SyncOperation['crdt'];
  value: Record<string, unknown>;
  hlc: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function mergeSyncOperation(current: SyncChange | undefined, operation: SyncOperation): SyncChange | undefined {
  if (current && current.crdt !== operation.crdt && !(current.crdt.startsWith('or_set_') && operation.crdt.startsWith('or_set_'))) return current;
  if (operation.crdt === 'lww') {
    if (current && compareHlcStrings(operation.hlc, current.hlc) <= 0) return current;
    return toChange(operation);
  }

  if (operation.crdt === 'max_ordinal') {
    const ordinal = operation.value.ordinal;
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) return current;
    const currentOrdinal = current?.value.ordinal;
    if (typeof currentOrdinal === 'number' && currentOrdinal > ordinal) return current;
    if (typeof currentOrdinal === 'number' && currentOrdinal === ordinal && current && compareHlcStrings(operation.hlc, current.hlc) <= 0) return current;
    return toChange(operation);
  }

  const previous = current?.value ?? { adds: {}, removedTags: [] };
  const adds = { ...asTagMap(previous.adds) };
  const removedTags = new Set(Array.isArray(previous.removedTags) ? previous.removedTags.filter((item): item is string => typeof item === 'string') : []);
  if (operation.crdt === 'or_set_add') {
    const tag = operation.value.tag;
    const text = operation.value.text;
    if (typeof tag !== 'string' || typeof text !== 'string') return current;
    adds[tag] = { text };
  } else {
    const tags = operation.value.tags;
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) return current;
    for (const tag of tags as string[]) removedTags.add(tag);
  }

  const value = { adds, removedTags: [...removedTags].sort() };
  if (current && JSON.stringify(value) === JSON.stringify(current.value)) return current;
  return { ...toChange(operation), value };
}

function asTagMap(value: unknown): Record<string, { text: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, { text: string }] => {
    const item = entry[1];
    return Boolean(item && typeof item === 'object' && 'text' in item && typeof item.text === 'string');
  }));
}

function toChange(operation: SyncOperation): SyncChange {
  return { entity: operation.entity, entityId: operation.entityId, field: operation.field, crdt: operation.crdt, value: operation.value, hlc: operation.hlc };
}

function compareHlcStrings(left: string, right: string): number {
  const parse = (value: string) => {
    const [physical, counter, ...node] = value.split(':');
    return { physical: Number(physical), counter: Number.parseInt(counter ?? '', 16), node: node.join(':') };
  };
  const a = parse(left);
  const b = parse(right);
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.node === b.node ? 0 : a.node < b.node ? -1 : 1;
}

export interface SyncStore {
  sync(driverId: string, request: SyncRequest): Promise<SyncResult>;
}

/** Development adapter. Production persistence will replace this with PostgreSQL. */
export class MemorySyncStore implements SyncStore {
  private readonly applied = new Map<string, Map<string, SyncOperation>>();
  private readonly versions = new Map<string, number>();
  private readonly changes = new Map<string, Array<{ version: number; change: SyncChange }>>();
  private readonly clock = new Map<string, Record<string, number>>();
  private readonly registers = new Map<string, Map<string, SyncChange>>();

  async sync(driverId: string, request: SyncRequest): Promise<SyncResult> {
    const driverOps = this.applied.get(driverId) ?? new Map<string, SyncOperation>();
    const driverChanges = this.changes.get(driverId) ?? [];
    const driverClock = this.clock.get(driverId) ?? { server: 0 };
    const driverRegisters = this.registers.get(driverId) ?? new Map<string, SyncChange>();
    let version = this.versions.get(driverId) ?? 0;
    const accepted: string[] = [];
    const rejected: Array<{ opId: string; reason: string }> = [];

    for (const operation of request.ops) {
      const existing = driverOps.get(operation.opId);
      if (existing && stableJson(existing) !== stableJson(operation)) {
        rejected.push({ opId: operation.opId, reason: 'op_id_reused_with_different_payload' });
        continue;
      }
      if (!existing) {
        version += 1;
        driverOps.set(operation.opId, operation);
        const key = `${operation.entity}:${operation.entityId}:${operation.field}`;
        const merged = mergeSyncOperation(driverRegisters.get(key), operation);
        if (merged) {
          driverRegisters.set(key, merged);
          driverChanges.push({ version, change: merged });
        }
      }
      accepted.push(operation.opId);
      for (const [nodeId, counter] of Object.entries(operation.vclock)) {
        driverClock[nodeId] = Math.max(driverClock[nodeId] ?? 0, counter);
      }
    }

    driverClock.server = version;
    this.applied.set(driverId, driverOps);
    this.changes.set(driverId, driverChanges);
    this.clock.set(driverId, driverClock);
    this.versions.set(driverId, version);
    this.registers.set(driverId, driverRegisters);

    const changes = driverChanges
      .filter(change => change.version > request.sinceServerVersion)
      .map(change => change.change);
    const mergedState: Record<string, Record<string, Record<string, Record<string, unknown>>>> = {};
    for (const change of driverRegisters.values()) {
      const entityState = mergedState[change.entity] ?? (mergedState[change.entity] = {});
      const tripState = entityState[change.entityId] ?? (entityState[change.entityId] = {});
      tripState[change.field] = change.value;
    }
    return { accepted, rejected, serverVersion: version, serverClock: { ...driverClock }, changes, mergedState };
  }
}


