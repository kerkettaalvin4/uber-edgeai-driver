import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { RedisResumeStore } from './redis-resume-store.js';
import { PostgresSyncStore } from './postgres-sync-store.js';

const secret = process.env.DEV_JWT_SECRET;
if (!secret) throw new Error('Set DEV_JWT_SECRET in the environment');
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL in the environment');
const pool = new Pool({ connectionString: databaseUrl });
const syncStore = new PostgresSyncStore(pool);
await syncStore.initialize();
const app = await createApp({
  jwtSecret: secret,
  resumeStore: new RedisResumeStore(redis),
  syncStore,
  nodeEnv: process.env.NODE_ENV,
});

const close = async () => {
  await app.close();
  await redis.quit();
  await pool.end();
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
await app.listen({ port: Number(process.env.PORT ?? 3001), host: process.env.HOST ?? '0.0.0.0' });

