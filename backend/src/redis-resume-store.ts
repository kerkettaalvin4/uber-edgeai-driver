import type { Redis } from 'ioredis';
import type { Envelope } from './protocol.js';
import type { ResumeStore } from './resume-store.js';

const TTL_SECONDS = 600;
const MAX_FRAMES = 500;

export class RedisResumeStore implements ResumeStore {
  constructor(private readonly redis: Redis) {}

  async nextServerSeq(streamId: string): Promise<number> {
    const seq = await this.redis.incr(`stream:${streamId}:seq`);
    await this.redis.expire(`stream:${streamId}:seq`, TTL_SECONDS);
    return seq;
  }

  async saveFrame(streamId: string, frame: Envelope): Promise<void> {
    const key = `stream:${streamId}:frames`;
    const transaction = this.redis.multi();
    transaction.zadd(key, frame.seq, JSON.stringify(frame));
    transaction.zremrangebyrank(key, 0, -(MAX_FRAMES + 1));
    transaction.expire(key, TTL_SECONDS);
    await transaction.exec();
  }

  async replayAfter(streamId: string, lastServerSeq: number): Promise<Envelope[] | null> {
    const key = `stream:${streamId}:frames`;
    const rows = await this.redis.zrange(key, 0, '-1');
    if (rows.length === 0) return [];
    const oldest = (JSON.parse(rows[0]!) as Envelope).seq;
    if (lastServerSeq < oldest - 1) return null;
    return rows
      .map(value => JSON.parse(value) as Envelope)
      .filter(frame => frame.seq > lastServerSeq);
  }
}

