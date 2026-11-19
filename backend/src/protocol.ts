import { z } from 'zod';

export const envelopeSchema = z.object({
  v: z.literal(1),
  type: z.string().min(1).max(100),
  seq: z.number().int().nonnegative(),
  ackSeq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  traceId: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()),
});

export type Envelope = z.infer<typeof envelopeSchema>;

export function createEnvelope(
  type: string,
  seq: number,
  ackSeq: number,
  payload: Record<string, unknown>,
  traceId = crypto.randomUUID(),
): Envelope {
  return { v: 1, type, seq, ackSeq, ts: Date.now(), traceId, payload };
}

