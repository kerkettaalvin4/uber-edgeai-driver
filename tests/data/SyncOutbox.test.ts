import { SyncOutbox, type KeyValueStorage } from '../../src/data/SyncOutbox';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
}

test('persists queued operations and clock metadata across instances', async () => {
  const storage = new MemoryStorage();
  const first = new SyncOutbox(storage, () => 1_800_000_000_000, jest.fn());
  const status = await first.transitionTripStatus('trip-1', 'ARRIVED_AT_PICKUP');
  expect(status).toBe('ARRIVED_AT_PICKUP');
  const operation = (await first.createRequest()).ops[0];

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
  await outbox.transitionTripStatus('trip-1', 'ARRIVED_AT_PICKUP');
  const operation = (await outbox.createRequest()).ops[0];

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

test('applies lifecycle rules locally and merges remote status without going backward', async () => {
  const outbox = new SyncOutbox(new MemoryStorage(), () => 1_800_000_000_000, jest.fn());
  expect(await outbox.transitionTripStatus('trip-1', 'ON_TRIP')).toBeNull();
  expect(await outbox.getTripStatus('trip-1')).toBe('EN_ROUTE_TO_PICKUP');

  await outbox.transitionTripStatus('trip-1', 'ARRIVED_AT_PICKUP');
  await outbox.applyReceipt({
    accepted: [], rejected: [], serverVersion: 2,
    mergedState: { trip: { 'trip-1': { status: { status: 'COMPLETED' } } } },
  });
  expect(await outbox.getTripStatus('trip-1')).toBe('COMPLETED');
  expect(await outbox.transitionTripStatus('trip-1', 'ON_TRIP')).toBeNull();
});
