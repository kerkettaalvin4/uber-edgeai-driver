import { GATEWAY_HTTP_URL, GATEWAY_WS_URL } from '../config/gateway';
import { SyncOutbox, type SyncReceipt } from './SyncOutbox';
import type { TripStatus } from '../domain/entities/TripStatus';

export type GatewayConnectionState = 'offline' | 'connecting' | 'live';

export interface GatewayFrame {
  v: 1;
  type: string;
  seq: number;
  ackSeq: number;
  ts: number;
  traceId: string;
  payload: Record<string, unknown>;
}

export interface ScenarioReplayReceipt {
  scenarioId: string;
  tripId: string;
  frameCount: number;
  maxMessagesPerSecond: number;
}

interface GatewayClientOptions {
  onStateChange: (state: GatewayConnectionState) => void;
  onFrame: (frame: GatewayFrame) => void;
  onError: (message: string) => void;
}

interface TokenResponse {
  token: string;
}

interface MobileWebSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface MobileWebSocketConstructor {
  new (url: string, protocols: null, options: { headers: Record<string, string> }): MobileWebSocket;
  OPEN: number;
  CONNECTING: number;
  CLOSING: number;
}

function isGatewayFrame(value: unknown): value is GatewayFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Partial<GatewayFrame>;
  return frame.v === 1
    && typeof frame.type === 'string'
    && Number.isInteger(frame.seq)
    && Number.isInteger(frame.ackSeq)
    && typeof frame.payload === 'object'
    && frame.payload !== null;
}

export class GatewayClient {
  private socket: MobileWebSocket | null = null;
  private token: string | null = null;
  private lastServerSeq = 0;
  private clientSeq = 0;

  constructor(
    private readonly options: GatewayClientOptions,
    private readonly syncOutbox = new SyncOutbox(),
  ) {}

  async connect(): Promise<void> {
    const WebSocketConstructor = globalThis.WebSocket as unknown as MobileWebSocketConstructor;
    if (this.socket?.readyState === WebSocketConstructor.OPEN) return;
    if (this.socket?.readyState === WebSocketConstructor.CONNECTING) throw new Error('Gateway connection is already starting');

    this.options.onError('');
    this.options.onStateChange('connecting');

    try {
      const tokenResponse = await fetch(`${GATEWAY_HTTP_URL}/v1/dev-token`, { method: 'POST' });
      if (!tokenResponse.ok) throw new Error(`Could not get a development token (${tokenResponse.status})`);
      const tokenBody = await tokenResponse.json() as TokenResponse;
      this.token = tokenBody.token;

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocketConstructor(GATEWAY_WS_URL + '/v1/stream', null, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        this.socket = socket;
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          socket.close();
          reject(new Error('Gateway connection timed out'));
        }, 10_000);

        socket.onopen = () => {
          this.send('session.resume', {
            lastServerSeq: this.lastServerSeq,
            lastClientSeqAcked: 0,
          });
          this.send('system.ping', { clientTime: Date.now() });
        };

        socket.onmessage = event => {
          try {
            const frame: unknown = JSON.parse(String(event.data));
            if (!isGatewayFrame(frame)) throw new Error('Gateway sent an invalid message envelope');
            if (frame.seq <= this.lastServerSeq) return;
            this.lastServerSeq = frame.seq;
            this.options.onFrame(frame);
            if (frame.type === 'system.pong' && !settled) {
              settled = true;
              clearTimeout(timeout);
              this.options.onStateChange('live');
              resolve();
            }
          } catch (error) {
            this.options.onError(error instanceof Error ? error.message : 'Could not read a gateway message');
          }
        };

        socket.onerror = () => {
          this.options.onStateChange('offline');
          const error = new Error('Could not connect to the gateway. Check that it is running and the app uses the correct host address.');
          this.options.onError(error.message);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(error);
          }
        };

        socket.onclose = () => {
          if (this.socket === socket) {
            this.socket = null;
            this.options.onStateChange('offline');
          }
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error('Gateway closed the connection before it opened'));
          }
        };
      });
    } catch (error) {
      this.options.onStateChange('offline');
      const message = error instanceof Error ? error.message : 'Could not connect to the gateway';
      this.options.onError(message);
      throw error;
    }
  }

  async replayScenario(tripId = 'trip-mobile-demo-001'): Promise<ScenarioReplayReceipt> {
    const WebSocketConstructor = globalThis.WebSocket as unknown as MobileWebSocketConstructor;
    if (!this.token || this.socket?.readyState !== WebSocketConstructor.OPEN) {
      throw new Error('Connect to the gateway before starting the drive');
    }
    const response = await fetch(`${GATEWAY_HTTP_URL}/v1/dev/scenarios/blr-short-drive-v1/replay`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tripId, maxMessagesPerSecond: 10 }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; hint?: string };
      throw new Error(body.hint ?? body.error ?? `Could not start the drive (${response.status})`);
    }
    return response.json() as Promise<ScenarioReplayReceipt>;
  }

  getTripStatus(tripId: string): Promise<TripStatus> {
    return this.syncOutbox.getTripStatus(tripId);
  }

  transitionTripStatus(tripId: string, nextStatus: TripStatus): Promise<TripStatus | null> {
    return this.syncOutbox.transitionTripStatus(tripId, nextStatus);
  }

  async syncPendingOperations(): Promise<SyncReceipt> {
    if (!this.token || this.socket?.readyState !== (globalThis.WebSocket as unknown as MobileWebSocketConstructor).OPEN) {
      throw new Error('Connect to the gateway before syncing trip status');
    }
    const syncRequest = await this.syncOutbox.createRequest();
    if (syncRequest.ops.length === 0) {
      return { accepted: [], rejected: [], serverVersion: syncRequest.sinceServerVersion };
    }
    const response = await fetch(`${GATEWAY_HTTP_URL}/v1/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(syncRequest),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Could not sync trip status (${response.status})`);
    }
    const receipt = await response.json() as SyncReceipt;
    await this.syncOutbox.applyReceipt(receipt);
    return receipt;
  }

  getPendingSyncCount(): Promise<number> {
    return this.syncOutbox.getPendingCount();
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.token = null;
    const WebSocketConstructor = globalThis.WebSocket as unknown as MobileWebSocketConstructor;
    if (socket && socket.readyState < WebSocketConstructor.CLOSING) socket.close(1000, 'driver disconnected');
    this.options.onStateChange('offline');
  }

  private send(type: string, payload: Record<string, unknown>): void {
    const WebSocketConstructor = globalThis.WebSocket as unknown as MobileWebSocketConstructor;
    if (!this.socket || this.socket.readyState !== WebSocketConstructor.OPEN) return;
    this.clientSeq += 1;
    this.socket.send(JSON.stringify({
      v: 1,
      type,
      seq: this.clientSeq,
      ackSeq: this.lastServerSeq,
      ts: Date.now(),
      traceId: `mobile-${Date.now()}-${this.clientSeq}`,
      payload,
    }));
  }
}
