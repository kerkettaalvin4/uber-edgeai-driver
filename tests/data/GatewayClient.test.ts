import { GatewayClient } from '../../src/data/GatewayClient';
import { SyncOutbox, type KeyValueStorage } from '../../src/data/SyncOutbox';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instance: FakeWebSocket;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(_url: string, _protocols?: string | string[] | null, _options?: unknown) {
    FakeWebSocket.instance = this;
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(type: string, seq: number, payload: Record<string, unknown> = {}) {
    this.onmessage?.({
      data: JSON.stringify({ v: 1, type, seq, ackSeq: 2, ts: Date.now(), traceId: 'test', payload }),
    });
  }
}

test('gets a development token, resumes the socket, and starts the scenario', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  const originalWebSocket = global.WebSocket;
  Object.defineProperty(global, 'WebSocket', { configurable: true, value: FakeWebSocket });
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'test-jwt' }) } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ scenarioId: 'blr-short-drive-v1', tripId: 'trip-test', frameCount: 17, maxMessagesPerSecond: 10 }) } as Response)
    .mockImplementationOnce(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ accepted: request.ops.map((op: { opId: string }) => op.opId), rejected: [], serverVersion: 1, serverClock: {}, changes: [] }) } as Response;
    });
  const states: string[] = [];
  const outbox = new SyncOutbox(new MemoryStorage(), () => 1_800_000_000_000, jest.fn());
  const client = new GatewayClient({ onStateChange: state => states.push(state), onFrame: jest.fn(), onError: jest.fn() }, outbox);

  try {
    const connection = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    const socket = FakeWebSocket.instance;
    socket.open();
    expect(socket.sent.map(message => JSON.parse(message).type)).toEqual(['session.resume', 'system.ping']);
    socket.receive('system.pong', 1);
    await connection;

    await expect(client.replayScenario('trip-test')).resolves.toMatchObject({ frameCount: 17 });
    await expect(client.transitionTripStatus('trip-test', 'ARRIVED_AT_PICKUP')).resolves.toBe('ARRIVED_AT_PICKUP');
    await expect(client.syncPendingOperations()).resolves.toMatchObject({ serverVersion: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ tripId: 'trip-test', maxMessagesPerSecond: 10 });
    const syncRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(syncRequest.ops[0].opId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(syncRequest.ops[0].value).toEqual({ status: 'ARRIVED_AT_PICKUP', ordinal: 3 });
    expect(syncRequest.ops[0].hlc).toContain(':0000:driver_');
    expect(await outbox.getPendingCount()).toBe(0);
    expect(states).toEqual(['connecting', 'live']);
  } finally {
    client.disconnect();
    fetchMock.mockRestore();
    Object.defineProperty(global, 'WebSocket', { configurable: true, value: originalWebSocket });
  }
});
