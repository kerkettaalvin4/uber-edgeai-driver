import { z } from 'zod';

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const syncOperationSchema = z.object({
  opId: z.string().regex(uuidV7, 'opId must be a UUIDv7'),
  entity: z.string().min(1).max(80),
  entityId: z.string().min(1).max(128),
  field: z.string().min(1).max(80),
  crdt: z.enum(['lww', 'max_ordinal', 'or_set_add', 'or_set_remove']),
  value: z.record(z.string(), z.unknown()),
  hlc: z.string().regex(/^\d+:[0-9a-fA-F]{4,}:[^:]+$/).max(128),
  vclock: z.record(z.string(), z.number().int().nonnegative()),
});

export const syncRequestSchema = z.object({
  sinceServerVersion: z.number().int().nonnegative(),
  clientClock: z.record(z.string(), z.number().int().nonnegative()),
  ops: z.array(syncOperationSchema).max(200),
});

export type SyncOperation = z.infer<typeof syncOperationSchema>;
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export interface SyncResult {
  accepted: string[];
  rejected: Array<{ opId: string; reason: string }>;
  serverVersion: number;
  serverClock: Record<string, number>;
  changes: SyncOperation[];
  mergedState: Record<string, unknown>;
}

export interface SyncStore {
  sync(driverId: string, request: SyncRequest): Promise<SyncResult>;
}

/** Development adapter. Production persistence will replace this with PostgreSQL. */
export class MemorySyncStore implements SyncStore {
  private readonly applied = new Map<string, Map<string, SyncOperation>>();
  private readonly versions = new Map<string, number>();
  private readonly changes = new Map<string, Array<{ version: number; operation: SyncOperation }>>();
  private readonly clock = new Map<string, Record<string, number>>();

  async sync(driverId: string, request: SyncRequest): Promise<SyncResult> {
    const driverOps = this.applied.get(driverId) ?? new Map<string, SyncOperation>();
    const driverChanges = this.changes.get(driverId) ?? [];
    const driverClock = this.clock.get(driverId) ?? { server: 0 };
    let version = this.versions.get(driverId) ?? 0;
    const accepted: string[] = [];

    for (const operation of request.ops) {
      if (!driverOps.has(operation.opId)) {
        version += 1;
        driverOps.set(operation.opId, operation);
        driverChanges.push({ version, operation });
      }
      accepted.push(operation.opId);
      for (const [nodeId, counter] of Object.entries(operation.vclock)) {
        driverClock[nodeId] = Math.max(driverClock[nodeId] ?? 0, counter);
      }
    }

    driverClock.server = version;
    this.applied.set(driverId, driverOps);
    this.changes.set(driverId, driverChanges);
    this.clock.set(driverId, driverClock);
    this.versions.set(driverId, version);

    const changes = driverChanges
      .filter(change => change.version > request.sinceServerVersion)
      .map(change => change.operation);
    return { accepted, rejected: [], serverVersion: version, serverClock: { ...driverClock }, changes, mergedState: {} };
  }
}

