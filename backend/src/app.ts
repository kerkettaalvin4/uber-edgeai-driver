import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { createEnvelope, envelopeSchema } from './protocol.js';
import type { ResumeStore } from './resume-store.js';
import { MemorySyncStore, syncRequestSchema, type SyncStore } from './sync.js';
import { buildScenarioMessages, listScenarios, SCENARIO_ID } from './scenario.js';

type SendFrame = (type: string, payload: Record<string, unknown>) => Promise<void>;

const replayRequestSchema = z.object({
  tripId: z.string().min(1).max(128).default('trip-dev-demo-001'),
  maxMessagesPerSecond: z.number().int().min(1).max(20).default(10),
});

export interface AppOptions {
  jwtSecret: string;
  resumeStore: ResumeStore;
  syncStore?: SyncStore;
  nodeEnv?: string;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  if (options.jwtSecret.length < 32) throw new Error('JWT secret must be at least 32 characters');
  const app = Fastify({ logger: true });
  await app.register(jwt, { secret: options.jwtSecret });
  await app.register(websocket);

  const streamsByDriver = new Map<string, Set<SendFrame>>();
  const replayingDrivers = new Set<string>();
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const header = request.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw new Error('Bearer token required');
      request.user = app.jwt.verify(header.slice(7));
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  app.get('/health', async () => ({ status: 'ok' }));

  const syncStore = options.syncStore ?? new MemorySyncStore();
  app.post('/v1/sync', {
    preValidation: authenticate,
  }, async (request, reply) => {
    const body = syncRequestSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_sync_request', issues: body.error.issues });
    const user = request.user as { sub?: string };
    if (!user.sub) return reply.code(401).send({ error: 'unauthorized' });
    return syncStore.sync(user.sub, body.data);
  });

  if (options.nodeEnv !== 'production') {
    app.post('/v1/dev-token', async (_request, reply) => {
      const token = app.jwt.sign({ sub: 'driver-dev-001', deviceId: 'device-dev-001' }, { expiresIn: '8h' });
      return reply.send({ token, tokenType: 'Bearer', expiresInSeconds: 28800 });
    });

    app.get('/v1/dev/scenarios', { preValidation: authenticate }, async () => ({ scenarios: listScenarios() }));
    app.post('/v1/dev/scenarios/:scenarioId/replay', { preValidation: authenticate }, async (request, reply) => {
      const { scenarioId } = request.params as { scenarioId: string };
      if (scenarioId !== SCENARIO_ID) return reply.code(404).send({ error: 'scenario_not_found' });
      const body = replayRequestSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_replay_request', issues: body.error.issues });
      const user = request.user as { sub?: string };
      if (!user.sub) return reply.code(401).send({ error: 'unauthorized' });
      const senders = streamsByDriver.get(user.sub);
      if (!senders?.size) return reply.code(409).send({ error: 'stream_not_ready', hint: 'Connect to /v1/stream and send session.resume first.' });
      if (replayingDrivers.has(user.sub)) return reply.code(409).send({ error: 'scenario_already_running' });

      const messages = buildScenarioMessages(body.data.tripId, Date.now(), user.sub);
      replayingDrivers.add(user.sub);
      (async () => {
        try {
          for (const message of messages) {
            const active = streamsByDriver.get(user.sub!);
            if (!active?.size) break;
            await Promise.all([...active].map(send => send(message.type, message.payload)));
            await new Promise(resolve => setTimeout(resolve, 1000 / body.data.maxMessagesPerSecond));
          }
        } catch (error) {
          app.log.error({ err: error, driverId: user.sub }, 'scenario replay failed');
        } finally {
          replayingDrivers.delete(user.sub!);
        }
      })();
      return reply.code(202).send({ scenarioId, tripId: body.data.tripId, frameCount: messages.length, maxMessagesPerSecond: body.data.maxMessagesPerSecond });
    });
  }

  app.get('/v1/stream', {
    websocket: true,
    preValidation: authenticate,
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
        const driverId = user.sub ?? 'unknown';
        const senders = streamsByDriver.get(driverId) ?? new Set<SendFrame>();
        senders.add(send);
        streamsByDriver.set(driverId, senders);
        socket.once('close', () => {
          senders.delete(send);
          if (senders.size === 0) streamsByDriver.delete(driverId);
        });
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


