import { SyncOutbox, type KeyValueStorage } from '../../src/data/SyncOutbox';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
}

test('persists queued operations and clock metadata across instances', async () => {
  const storage = new MemoryStorage();
  const first = new SyncOutbox(storage, () => 1_800_000_000_000, jest.fn());
  const operation = await first.enqueueTripStatus('trip-1', 'ARRIVED_AT_PICKUP', 3);

  const restarted = new SyncOutbox(storage, () => 1_800_000_000_001, jest.fn());
  const request = await restarted.createRequest();
  expect(request.ops).toEqual([operation]);
  expect(request.ops[0].hlc).toContain(':0000:driver_');
  expect(request.clientClock[request.ops[0].hlc.split(':')[2]]).toBe(1);
});

test('removes acknowledged operations and warns when a received clock is far ahead', async () => {
  const storage = new MemoryStorage();
  const onClockSkew = jest.fn();
  const outbox = new SyncOutbox(storage, () => 1_800_000_000_000, onClockSkew);
  const operation = await outbox.enqueueTripStatus('trip-1', 'ARRIVED_AT_PICKUP', 3);

  await outbox.applyReceipt({
    accepted: [operation.opId],
    rejected: [],
    serverVersion: 1,
    serverClock: { server: 1 },
    changes: [{ hlc: '1800000061000:0001:server' }],
  });

  expect(await outbox.getPendingCount()).toBe(0);
  expect(onClockSkew).toHaveBeenCalledWith(61_000);
  expect((await outbox.createRequest()).sinceServerVersion).toBe(1);
});
