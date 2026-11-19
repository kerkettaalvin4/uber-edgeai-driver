import { describe, expect, it } from 'vitest';
import { MemorySyncStore, mergeSyncOperation, type SyncOperation, type SyncRequest } from '../src/sync.js';

function operation(fields: Partial<SyncOperation> & Pick<SyncOperation, 'crdt' | 'value' | 'hlc'>): SyncOperation {
  return {
    opId: '0192f7a1-6b2e-7c11-9a3d-5e2f1c0b7d44',
    entity: 'trip', entityId: 'trip-1', field: 'status', vclock: { device: 1 },
    ...fields,
  };
}

describe('sync CRDT merge rules', () => {
  it('keeps the larger ordinal when an older status arrives late', () => {
    const arrived = operation({ crdt: 'max_ordinal', value: { status: 'ARRIVED', ordinal: 3 }, hlc: '1000:0001:device-a' });
    const enRoute = operation({ crdt: 'max_ordinal', value: { status: 'EN_ROUTE', ordinal: 2 }, hlc: '2000:0001:device-b' });
    const current = mergeSyncOperation(undefined, arrived)!;
    expect(mergeSyncOperation(current, enRoute)?.value).toEqual({ status: 'ARRIVED', ordinal: 3 });
  });

  it('uses HLC order for last-writer-wins values', () => {
    const earlier = operation({ crdt: 'lww', field: 'dropoff', value: { label: 'Old' }, hlc: '1000:0001:device-a' });
    const later = operation({ crdt: 'lww', field: 'dropoff', value: { label: 'New' }, hlc: '1001:0000:device-a' });
    expect(mergeSyncOperation(mergeSyncOperation(undefined, earlier), later)?.value).toEqual({ label: 'New' });
  });

  it('unions observed remove tags without deleting a concurrent OR-set add', () => {
    const first = operation({ crdt: 'or_set_add', field: 'stopNotes', value: { tag: 'device:1', text: 'Gate code' }, hlc: '1000:0001:device-a' });
    const second = operation({ crdt: 'or_set_add', field: 'stopNotes', value: { tag: 'device:2', text: 'Use side door' }, hlc: '1001:0000:device-a' });
    const remove = operation({ crdt: 'or_set_remove', field: 'stopNotes', value: { tags: ['device:1'] }, hlc: '1002:0000:device-a' });
    const afterAdds = mergeSyncOperation(mergeSyncOperation(undefined, first), second)!;
    const afterRemove = mergeSyncOperation(afterAdds, remove)!;
    expect(afterRemove.value).toEqual({
      adds: { 'device:1': { text: 'Gate code' }, 'device:2': { text: 'Use side door' } },
      removedTags: ['device:1'],
    });
  });

  it('rejects reusing an opId with a different payload', async () => {
    const store = new MemorySyncStore();
    const first = operation({ crdt: 'lww', field: 'dropoff', value: { label: 'First' }, hlc: '1000:0001:device-a' });
    const changed = { ...first, value: { label: 'Different' } };
    const request: SyncRequest = { sinceServerVersion: 0, clientClock: {}, ops: [first] };
    await store.sync('driver-1', request);
    const result = await store.sync('driver-1', { ...request, ops: [changed] });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ opId: first.opId, reason: 'op_id_reused_with_different_payload' }]);
  });
});

