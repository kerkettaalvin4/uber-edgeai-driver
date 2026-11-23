import { GATEWAY_HTTP_URL, GATEWAY_WS_URL } from '../config/gateway';
import { SyncOutbox, type SyncReceipt } from './SyncOutbox';
import type { TripStatus } from '../domain/entities/TripStatus';

export type GatewayConnectionState = 'offline' | 'connecting' | 'live' | 'reconnecting';

const HEARTBEAT_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const STABLE_CONNECTION_MS = 60_000;

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
  private wantsConnection = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;

  constructor(
    private readonly options: GatewayClientOptions,
    private readonly syncOutbox = new SyncOutbox(),
  ) {}

  async connect(): Promise<void> {
    const WebSocketConstructor = globalThis.WebSocket as unknown as MobileWebSocketConstructor;
    this.wantsConnection = true;
    if (this.socket?.readyState === WebSocketConstructor.OPEN) return;
    if (this.socket?.readyState === WebSocketConstructor.CONNECTING) return;
    this.clearReconnectTimer();
    this.options.onError('');
    this.options.onStateChange('connecting');

    try {
      await this.openSocket(false);
    } catch (error) {
      if (!this.wantsConnection) return;
      const message = error instanceof Error ? error.message : 'Could not connect to the gateway';
      this.options.onError(message);
      this.scheduleReconnect();
      throw error;
    }
  }

  private async openSocket(isRetry: boolean): Promise<void> {
    const WebSocketConstructor = globalThis.WebSocket as unknown as MobileWebSocketConstructor;
    if (isRetry) this.options.onStateChange('reconnecting');
    const tokenResponse = await fetch(`${GATEWAY_HTTP_URL}/v1/dev-token`, { method: 'POST' });
    if (!tokenResponse.ok) throw new Error(`Could not get a development token (${tokenResponse.status})`);
    const tokenBody = await tokenResponse.json() as TokenResponse;
    if (!this.wantsConnection) return;
    this.token = tokenBody.token;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocketConstructor(GATEWAY_WS_URL + '/v1/stream', null, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      this.socket = socket;
      let handshakeSettled = false;
      const finishHandshake = (error?: Error) => {
        if (handshakeSettled) return;
        handshakeSettled = true;
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        if (error) reject(error);
        else resolve();
      };

      this.handshakeTimer = setTimeout(() => {
        socket.close(4000, 'gateway handshake timed out');
        finishHandshake(new Error('Gateway connection timed out'));
      }, PONG_TIMEOUT_MS);

      socket.onopen = () => {
        this.send('session.resume', {
          lastServerSeq: this.lastServerSeq,
          lastClientSeqAcked: 0,
        });
        this.sendHeartbeatPing(socket);
      };

      socket.onmessage = event => {
        try {
          const frame: unknown = JSON.parse(String(event.data));
          if (!isGatewayFrame(frame)) throw new Error('Gateway sent an invalid message envelope');
          if (frame.seq <= this.lastServerSeq) return;
          this.lastServerSeq = frame.seq;
          this.options.onFrame(frame);
          if (frame.type === 'system.pong') {
            this.clearPongTimer();
            this.awaitingPong = false;
            if (!handshakeSettled) {
              finishHandshake();
              this.options.onError('');
              this.options.onStateChange('live');
              this.startHeartbeat(socket);
              this.startStableTimer();
            }
          }
        } catch (error) {
          this.options.onError(error instanceof Error ? error.message : 'Could not read a gateway message');
        }
      };

      socket.onerror = () => {
        this.options.onError('Could not connect to the gateway. It will retry while Online.');
        socket.close();
      };

      socket.onclose = () => {
        const wasCurrentSocket = this.socket === socket;
        if (wasCurrentSocket) this.socket = null;
        this.clearTransportTimers();
        finishHandshake(new Error('Gateway closed the connection before it opened'));
        if (wasCurrentSocket && this.wantsConnection) this.scheduleReconnect();
        else if (wasCurrentSocket) this.options.onStateChange('offline');
      };
    });
  }

  private startHeartbeat(socket: MobileWebSocket): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const WebSocketConstructor = globalThis.WebSocket as unknown as MobileWebSocketConstructor;
      if (this.socket !== socket || socket.readyState !== WebSocketConstructor.OPEN || this.awaitingPong) return;
      this.sendHeartbeatPing(socket);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private sendHeartbeatPing(socket: MobileWebSocket): void {
    this.awaitingPong = true;
    this.send('system.ping', { clientTime: Date.now() });
    this.clearPongTimer();
    this.pongTimer = setTimeout(() => {
      this.options.onError('Gateway heartbeat timed out. Reconnecting…');
      socket.close(4000, 'heartbeat timeout');
    }, PONG_TIMEOUT_MS);
  }

  private startStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.reconnectAttempts = 0;
      this.stableTimer = null;
    }, STABLE_CONNECTION_MS);
  }

  private scheduleReconnect(): void {
    if (!this.wantsConnection || this.reconnectTimer) return;
    const delayCap = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * (2 ** this.reconnectAttempts));
    this.reconnectAttempts += 1;
    const delay = Math.floor(Math.random() * delayCap);
    this.options.onStateChange('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(true).catch(error => {
        this.options.onError(error instanceof Error ? error.message : 'Gateway reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearTransportTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.heartbeatTimer = null;
    this.stableTimer = null;
    this.clearPongTimer();
    this.awaitingPong = false;
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
    this.wantsConnection = false;
    this.clearReconnectTimer();
    this.clearTransportTimers();
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
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
