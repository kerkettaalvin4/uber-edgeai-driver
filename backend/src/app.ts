import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { createEnvelope, envelopeSchema } from './protocol.js';
import type { ResumeStore } from './resume-store.js';

export interface AppOptions {
  jwtSecret: string;
  resumeStore: ResumeStore;
  nodeEnv?: string;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  if (options.jwtSecret.length < 32) throw new Error('JWT secret must be at least 32 characters');
  const app = Fastify({ logger: true });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(websocket);

  app.get('/health', async () => ({ status: 'ok' }));

  if (options.nodeEnv !== 'production') {
    app.post('/v1/dev-token', async (_request, reply) => {
      const token = app.jwt.sign({ sub: 'driver-dev-001', deviceId: 'device-dev-001' }, { expiresIn: '8h' });
      return reply.send({ token, tokenType: 'Bearer', expiresInSeconds: 28800 });
    });
  }

  app.get('/v1/stream', {
    websocket: true,
    preValidation: async (request, reply) => {
      try {
        const header = request.headers.authorization;
        if (!header?.startsWith('Bearer ')) throw new Error('Bearer token required');
        request.user = app.jwt.verify(header.slice(7));
      } catch {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    },
  }, (socket: WebSocket, request) => {
    const user = request.user as { sub?: string; deviceId?: string };
    const streamId = `${user.sub ?? 'unknown'}:${user.deviceId ?? 'unknown'}`;
    let resumed = false;
    let lastClientSeq = 0;

    const send = async (type: string, payload: Record<string, unknown>) => {
      const seq = await options.resumeStore.nextServerSeq(streamId);
      const frame = createEnvelope(type, seq, lastClientSeq, payload);
      await options.resumeStore.saveFrame(streamId, frame);
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };

    socket.on('message', async (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, 'Invalid JSON');
        return;
      }
      const result = envelopeSchema.safeParse(parsed);
      if (!result.success) {
        socket.close(1008, 'Invalid envelope');
        return;
      }
      const frame = result.data;
      lastClientSeq = Math.max(lastClientSeq, frame.seq);
      if (!resumed) {
        if (frame.type !== 'session.resume') {
          socket.close(1008, 'session.resume required');
          return;
        }
        const last = frame.payload.lastServerSeq;
        if (!Number.isInteger(last) || Number(last) < 0) {
          socket.close(1008, 'Invalid resume cursor');
          return;
        }
        resumed = true;
        const replay = await options.resumeStore.replayAfter(streamId, Number(last));
        if (replay === null) {
          await send('resume.gap', { reason: 'buffer_expired', requiresSnapshot: true });
        } else {
          for (const item of replay) {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(item));
          }
        }
        return;
      }
      if (frame.type === 'system.ping') await send('system.pong', { clientTime: frame.ts });
    });
  });

  return app;
}

