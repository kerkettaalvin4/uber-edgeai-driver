import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { createEnvelope } from '../src/protocol.js';
import { MemoryResumeStore } from '../src/resume-store.js';

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
});

