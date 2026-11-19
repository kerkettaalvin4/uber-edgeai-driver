import type { Envelope } from './protocol.js';

export interface ResumeStore {
  nextServerSeq(streamId: string): Promise<number>;
  saveFrame(streamId: string, frame: Envelope): Promise<void>;
  replayAfter(streamId: string, lastServerSeq: number): Promise<Envelope[] | null>;
}

export class MemoryResumeStore implements ResumeStore {
  private readonly sequences = new Map<string, number>();
  private readonly frames = new Map<string, Envelope[]>();

  async nextServerSeq(streamId: string): Promise<number> {
    const next = (this.sequences.get(streamId) ?? 0) + 1;
    this.sequences.set(streamId, next);
    return next;
  }

  async saveFrame(streamId: string, frame: Envelope): Promise<void> {
    const frames = this.frames.get(streamId) ?? [];
    frames.push(frame);
    this.frames.set(streamId, frames.slice(-500));
  }

  async replayAfter(streamId: string, lastServerSeq: number): Promise<Envelope[] | null> {
    const frames = this.frames.get(streamId) ?? [];
    const oldest = frames[0]?.seq;
    if (oldest !== undefined && lastServerSeq < oldest - 1) return null;
    return frames.filter(frame => frame.seq > lastServerSeq);
  }
}

