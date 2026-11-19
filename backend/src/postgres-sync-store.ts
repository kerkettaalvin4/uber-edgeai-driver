import type { Pool, PoolClient } from 'pg';
import { mergeSyncOperation, type SyncChange, type SyncRequest, type SyncResult, type SyncStore } from './sync.js';

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
      CREATE TABLE IF NOT EXISTS sync_registers (
        driver_id TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        field TEXT NOT NULL,
        crdt TEXT NOT NULL,
        value_json JSONB NOT NULL,
        hlc TEXT NOT NULL,
        PRIMARY KEY (driver_id, entity, entity_id, field)
      );
      CREATE TABLE IF NOT EXISTS sync_changes (
        driver_id TEXT NOT NULL,
        server_version BIGINT NOT NULL,
        change_json JSONB NOT NULL,
        PRIMARY KEY (driver_id, server_version)
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
      const rejected: Array<{ opId: string; reason: string }> = [];

      for (const operation of request.ops) {
        const inserted = await client.query(
          `INSERT INTO sync_ops (driver_id, op_id, operation)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (driver_id, op_id) DO NOTHING
           RETURNING op_id`,
          [driverId, operation.opId, JSON.stringify(operation)],
        );
        if (!inserted.rowCount) {
          const existing = await client.query(
            'SELECT operation = $3::jsonb AS same FROM sync_ops WHERE driver_id = $1 AND op_id = $2',
            [driverId, operation.opId, JSON.stringify(operation)],
          );
          if (!existing.rows[0]?.same) {
            rejected.push({ opId: operation.opId, reason: 'op_id_reused_with_different_payload' });
            continue;
          }
          accepted.push(operation.opId);
          continue;
        }
        if (inserted.rowCount) {
          const registerKey = `${driverId}:${operation.entity}:${operation.entityId}:${operation.field}`;
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [registerKey]);
          const currentResult = await client.query(
            `SELECT entity, entity_id, field, crdt, value_json AS value, hlc
             FROM sync_registers WHERE driver_id = $1 AND entity = $2 AND entity_id = $3 AND field = $4 FOR UPDATE`,
            [driverId, operation.entity, operation.entityId, operation.field],
          );
          const row = currentResult.rows[0];
          const current: SyncChange | undefined = row ? {
            entity: row.entity,
            entityId: row.entity_id,
            field: row.field,
            crdt: row.crdt,
            value: row.value,
            hlc: row.hlc,
          } : undefined;
          const merged = mergeSyncOperation(current, operation);
          const result = await client.query(
            'UPDATE sync_meta SET server_version = server_version + 1 WHERE driver_id = $1 RETURNING server_version',
            [driverId],
          );
          const version = Number(result.rows[0].server_version);
          await client.query('UPDATE sync_ops SET server_version = $3 WHERE driver_id = $1 AND op_id = $2', [driverId, operation.opId, version]);
          if (merged && (!current || JSON.stringify(current) !== JSON.stringify(merged))) {
            await client.query(
              `INSERT INTO sync_registers (driver_id, entity, entity_id, field, crdt, value_json, hlc)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
               ON CONFLICT (driver_id, entity, entity_id, field) DO UPDATE
               SET crdt = EXCLUDED.crdt, value_json = EXCLUDED.value_json, hlc = EXCLUDED.hlc`,
              [driverId, merged.entity, merged.entityId, merged.field, merged.crdt, JSON.stringify(merged.value), merged.hlc],
            );
            await client.query('INSERT INTO sync_changes (driver_id, server_version, change_json) VALUES ($1, $2, $3::jsonb)', [driverId, version, JSON.stringify(merged)]);
          }
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
        `SELECT change_json FROM sync_changes
         WHERE driver_id = $1 AND server_version > $2
         ORDER BY server_version`,
        [driverId, request.sinceServerVersion],
      );
      const stateResult = await client.query('SELECT entity, entity_id, field, value_json FROM sync_registers WHERE driver_id = $1', [driverId]);
      await client.query('COMMIT');

      const mergedState: Record<string, Record<string, Record<string, Record<string, unknown>>>> = {};
      for (const row of stateResult.rows) {
        const entityState = mergedState[row.entity] ?? (mergedState[row.entity] = {});
        const tripState = entityState[row.entity_id] ?? (entityState[row.entity_id] = {});
        tripState[row.field] = row.value_json as Record<string, unknown>;
      }

      return {
        accepted,
        rejected,
        serverVersion,
        serverClock,
        changes: changesResult.rows.map(row => row.change_json as SyncChange),
        mergedState,
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


