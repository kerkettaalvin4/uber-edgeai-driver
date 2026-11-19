import type { Pool, PoolClient } from 'pg';
import type { SyncOperation, SyncRequest, SyncResult, SyncStore } from './sync.js';

export class PostgresSyncStore implements SyncStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sync_meta (
        driver_id TEXT PRIMARY KEY,
        server_version BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sync_ops (
        driver_id TEXT NOT NULL,
        op_id UUID NOT NULL,
        operation JSONB NOT NULL,
        server_version BIGINT,
        PRIMARY KEY (driver_id, op_id)
      );
      CREATE TABLE IF NOT EXISTS sync_clock (
        driver_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        counter BIGINT NOT NULL,
        PRIMARY KEY (driver_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS sync_ops_changes_idx
        ON sync_ops (driver_id, server_version) WHERE server_version IS NOT NULL;
    `);
  }

  async sync(driverId: string, request: SyncRequest): Promise<SyncResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO sync_meta (driver_id) VALUES ($1) ON CONFLICT DO NOTHING', [driverId]);
      const accepted: string[] = [];

      for (const operation of request.ops) {
        const inserted = await client.query(
          `INSERT INTO sync_ops (driver_id, op_id, operation)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (driver_id, op_id) DO NOTHING
           RETURNING op_id`,
          [driverId, operation.opId, JSON.stringify(operation)],
        );
        if (inserted.rowCount) {
          const result = await client.query(
            'UPDATE sync_meta SET server_version = server_version + 1 WHERE driver_id = $1 RETURNING server_version',
            [driverId],
          );
          const version = Number(result.rows[0].server_version);
          await client.query('UPDATE sync_ops SET server_version = $3 WHERE driver_id = $1 AND op_id = $2', [driverId, operation.opId, version]);
        }
        accepted.push(operation.opId);
        await this.mergeClock(client, driverId, operation.vclock);
      }

      await this.mergeClock(client, driverId, request.clientClock);
      const versionResult = await client.query('SELECT server_version FROM sync_meta WHERE driver_id = $1', [driverId]);
      const serverVersion = Number(versionResult.rows[0].server_version);
      await this.mergeClock(client, driverId, { server: serverVersion });

      const clockResult = await client.query('SELECT node_id, counter FROM sync_clock WHERE driver_id = $1', [driverId]);
      const serverClock = Object.fromEntries(clockResult.rows.map(row => [row.node_id as string, Number(row.counter)]));
      const changesResult = await client.query(
        `SELECT operation FROM sync_ops
         WHERE driver_id = $1 AND server_version > $2
         ORDER BY server_version LIMIT 1000`,
        [driverId, request.sinceServerVersion],
      );
      await client.query('COMMIT');

      return {
        accepted,
        rejected: [],
        serverVersion,
        serverClock,
        changes: changesResult.rows.map(row => row.operation as SyncOperation),
        mergedState: {},
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async mergeClock(client: PoolClient, driverId: string, clock: Record<string, number>): Promise<void> {
    for (const [nodeId, counter] of Object.entries(clock)) {
      await client.query(
        `INSERT INTO sync_clock (driver_id, node_id, counter) VALUES ($1, $2, $3)
         ON CONFLICT (driver_id, node_id) DO UPDATE
         SET counter = GREATEST(sync_clock.counter, EXCLUDED.counter)`,
        [driverId, nodeId, counter],
      );
    }
  }
}

