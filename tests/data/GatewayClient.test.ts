import { GatewayClient } from '../../src/data/GatewayClient';

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
    .mockResolvedValueOnce({ ok: true, json: async () => ({ accepted: ['0192f7a1-6b2e-7c11-9a3d-5e2f1c0b7d44'], rejected: [], serverVersion: 1 }) } as Response);
  const states: string[] = [];
  const client = new GatewayClient({ onStateChange: state => states.push(state), onFrame: jest.fn(), onError: jest.fn() });

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
    await expect(client.syncDemoStatus('trip-test')).resolves.toMatchObject({ serverVersion: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ tripId: 'trip-test', maxMessagesPerSecond: 10 });
    const syncRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(syncRequest.ops[0].opId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(syncRequest.ops[0].value).toEqual({ status: 'ARRIVED_AT_PICKUP', ordinal: 3 });
    expect(states).toEqual(['connecting', 'live']);
  } finally {
    client.disconnect();
    fetchMock.mockRestore();
    Object.defineProperty(global, 'WebSocket', { configurable: true, value: originalWebSocket });
  }
});
