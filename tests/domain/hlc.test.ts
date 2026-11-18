import {
  compareHlc,
  createHlc,
  hlcNow,
  hlcReceive,
  parseHlc,
  serializeHlc,
} from '../../src/domain/hlc';

describe('Hybrid Logical Clock', () => {
  it('starts at wall time and resets the counter when time advances', () => {
    const current = createHlc('device-a', 1_000);

    expect(hlcNow(current, 1_001)).toEqual({
      physicalMs: 1_001,
      logicalCounter: 0,
      nodeId: 'device-a',
    });
  });

  it('keeps increasing when wall time stalls or moves backward', () => {
    const current = { ...createHlc('device-a', 1_000), logicalCounter: 4 };

    expect(hlcNow(current, 1_000)).toEqual({
      physicalMs: 1_000,
      logicalCounter: 5,
      nodeId: 'device-a',
    });
    expect(hlcNow(current, 900).logicalCounter).toBe(5);
  });

  it('incorporates the newer of local, remote, and wall clocks', () => {
    const local = { ...createHlc('device-a', 1_000), logicalCounter: 3 };
    const remote = { ...createHlc('server', 1_200), logicalCounter: 2 };

    expect(hlcReceive(local, remote, 1_100)).toEqual({
      timestamp: {
        physicalMs: 1_200,
        logicalCounter: 3,
        nodeId: 'device-a',
      },
      clockSkewMs: 100,
    });
  });

  it('increments beyond both counters when physical clocks tie', () => {
    const local = { ...createHlc('device-a', 2_000), logicalCounter: 4 };
    const remote = { ...createHlc('server', 2_000), logicalCounter: 7 };

    expect(hlcReceive(local, remote, 2_000).timestamp).toEqual({
      physicalMs: 2_000,
      logicalCounter: 8,
      nodeId: 'device-a',
    });
  });

  it('accepts a device clock ten minutes ahead and reports the skew', () => {
    const local = createHlc('device-a', 1_000_000);
    const remote = { ...createHlc('server', 1_600_000), logicalCounter: 2 };
    const received = hlcReceive(local, remote, 1_000_000);

    expect(received.timestamp.physicalMs).toBe(1_600_000);
    expect(received.timestamp.logicalCounter).toBe(3);
    expect(received.clockSkewMs).toBe(600_000);
    expect(compareHlc(received.timestamp, local)).toBeGreaterThan(0);
  });

  it('orders by physical time, counter, and then node id', () => {
    const first = { ...createHlc('device-a', 5_000), logicalCounter: 2 };
    const laterCounter = { ...first, logicalCounter: 3 };
    const laterNode = { ...first, nodeId: 'device-b' };

    expect(compareHlc(first, laterCounter)).toBeLessThan(0);
    expect(compareHlc(first, laterNode)).toBeLessThan(0);
    expect(compareHlc(laterCounter, first)).toBeGreaterThan(0);
    expect(compareHlc(first, first)).toBe(0);
  });

  it('round-trips the PRD timestamp format with a four-digit hex counter', () => {
    const timestamp = {
      ...createHlc('device-a', 1_791_460_401_222),
      logicalCounter: 4,
    };

    expect(serializeHlc(timestamp)).toBe('1791460401222:0004:device-a');
    expect(parseHlc(serializeHlc(timestamp))).toEqual(timestamp);
  });

  it('rejects malformed serialized clocks', () => {
    expect(() => parseHlc('12:4:device-a')).toThrow(TypeError);
    expect(() => parseHlc('12:0001:')).toThrow(TypeError);
    expect(() => createHlc('device:a', 12)).toThrow(TypeError);
  });
});
