import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { createEnvelope } from '../src/protocol.js';
import { MemoryResumeStore } from '../src/resume-store.js';
import type { SyncOperation, SyncRequest } from '../src/sync.js';

const SECRET = 'local-test-secret-which-is-at-least-32-characters';
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

async function start(nodeEnv = 'test') {
  const app = await createApp({ jwtSecret: SECRET, resumeStore: new MemoryResumeStore(), nodeEnv });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

function receive(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', data => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
}

afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('telemetry gateway', () => {
  it('issues a development JWT and disables the route in production', async () => {
    const app = await start();
    const response = await app.inject({ method: 'POST', url: '/v1/dev-token' });
    expect(response.statusCode).toBe(200);
    expect(response.json().token).toEqual(expect.any(String));
    const production = await start('production');
    expect((await production.inject({ method: 'POST', url: '/v1/dev-token' })).statusCode).toBe(404);
  });

  it('requires a JWT before allowing the WebSocket connection', async () => {
    const app = await start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream`);
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      socket.once('error', reject);
    });
    expect(status).toBe(401);
  });

  it('accepts resume then answers heartbeat with a sequenced pong', async () => {
    const app = await start();
    const tokenResponse = await app.inject({ method: 'POST', url: '/v1/dev-token' });
    const token = tokenResponse.json().token as string;
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream`, { headers: { authorization: `Bearer ${token}` } });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const resume = createEnvelope('session.resume', 1, 0, { lastServerSeq: 0, lastClientSeqAcked: 0 });
    socket.send(JSON.stringify(resume));
    const ping = createEnvelope('system.ping', 2, 0, {});
    const pongPromise = receive(socket);
    socket.send(JSON.stringify(ping));
    const pong = await pongPromise as ReturnType<typeof createEnvelope>;
    expect(pong.type).toBe('system.pong');
    expect(pong.seq).toBeGreaterThan(0);
    socket.close();
  });

  it('accepts authenticated sync operations and deduplicates UUIDv7 opIds', async () => {
    const app = await start();
    const token = (await app.inject({ method: 'POST', url: '/v1/dev-token' })).json().token as string;
    const operation: SyncOperation = {
      opId: '0192f7a1-6b2e-7c11-9a3d-5e2f1c0b7d44',
      entity: 'trip', entityId: 'trip-1', field: 'status', crdt: 'max_ordinal',
      value: { status: 'ARRIVED_AT_PICKUP', ordinal: 3 },
      hlc: '1791460401222:0004:dev_a19c', vclock: { dev_a19c: 55, server: 30410 },
    };
    const request: SyncRequest = { sinceServerVersion: 0, clientClock: { dev_a19c: 55, server: 30410 }, ops: [operation] };
    const first = await app.inject({ method: 'POST', url: '/v1/sync', headers: { authorization: `Bearer ${token}` }, payload: request });
    const retry = await app.inject({ method: 'POST', url: '/v1/sync', headers: { authorization: `Bearer ${token}` }, payload: request });
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted).toEqual([operation.opId]);
    expect(retry.json().accepted).toEqual([operation.opId]);
    expect(retry.json().serverVersion).toBe(first.json().serverVersion);
  });

  it('rejects malformed sync operations', async () => {
    const app = await start();
    const token = (await app.inject({ method: 'POST', url: '/v1/dev-token' })).json().token as string;
    const response = await app.inject({
      method: 'POST', url: '/v1/sync', headers: { authorization: `Bearer ${token}` },
      payload: { sinceServerVersion: 0, clientClock: {}, ops: [{ opId: 'not-a-uuidv7' }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('replays the synthetic drive, surge cycles, and route update to a resumed stream', async () => {
    const app = await start();
    const token = (await app.inject({ method: 'POST', url: '/v1/dev-token' })).json().token as string;
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream`, { headers: { authorization: `Bearer ${token}` } });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify(createEnvelope('session.resume', 1, 0, { lastServerSeq: 0, lastClientSeqAcked: 0 })));
    const pongPromise = receive(socket);
    socket.send(JSON.stringify(createEnvelope('system.ping', 2, 0, {})));
    await pongPromise;

    const frames: Array<Record<string, unknown>> = [];
    const expectedCount = 17;
    const messagesDone = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Scenario replay timed out')), 5_000);
      socket.on('message', data => {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (frames.length === expectedCount) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    const response = await app.inject({
      method: 'POST', url: '/v1/dev/scenarios/blr-short-drive-v1/replay',
      headers: { authorization: `Bearer ${token}` },
      payload: { tripId: 'trip-demo-1', maxMessagesPerSecond: 20 },
    });
    expect(response.statusCode).toBe(202);
    await messagesDone;
    const types = frames.map(frame => frame.type);
    expect(types.filter(type => type === 'telemetry.location.batch')).toHaveLength(11);
    expect(types.filter(type => type === 'pricing.surge')).toHaveLength(5);
    expect(types.filter(type => type === 'route.update')).toHaveLength(1);
    expect(frames.map(frame => frame.seq)).toEqual([...frames.map(frame => frame.seq)].sort((a, b) => Number(a) - Number(b)));
    socket.close();
  });
});


