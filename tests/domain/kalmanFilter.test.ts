import { ConstantVelocityKalmanFilter } from '../../src/domain/location/kalmanFilter';

describe('ConstantVelocityKalmanFilter', () => {
  it('smooths a noisy location measurement in local east/north coordinates', () => {
    const filter = new ConstantVelocityKalmanFilter();
    filter.process({ latitude: 0, longitude: 0, accuracyM: 5, timestampMs: 1_000 });

    const next = filter.process({
      latitude: 0.00009,
      longitude: 0,
      accuracyM: 5,
      timestampMs: 2_000,
    });

    expect(next.accepted).toBe(true);
    if (!next.accepted) return;
    expect(next.location.latitude).toBeGreaterThan(0);
    expect(next.location.latitude).toBeLessThan(0.00009);
    expect(next.location.speedMps).toBeGreaterThan(0);
    expect(next.reset).toBe(false);
  });

  it('rejects fixes with more than 50 metres of reported accuracy', () => {
    const filter = new ConstantVelocityKalmanFilter();
    const result = filter.process({ latitude: 12, longitude: 77, accuracyM: 50.1, timestampMs: 1_000 });
    expect(result).toEqual({ accepted: false, reason: 'poor_accuracy' });
  });

  it('rejects an implied speed above 55 metres per second without advancing its state', () => {
    const filter = new ConstantVelocityKalmanFilter();
    filter.process({ latitude: 0, longitude: 0, accuracyM: 5, timestampMs: 1_000 });
    const result = filter.process({ latitude: 0.0009, longitude: 0, accuracyM: 5, timestampMs: 2_000 });
    expect(result).toEqual({ accepted: false, reason: 'impossible_speed' });

    const next = filter.process({ latitude: 0.00009, longitude: 0, accuracyM: 5, timestampMs: 3_000 });
    expect(next.accepted).toBe(true);
  });

  it('resets position and velocity after a gap longer than 30 seconds', () => {
    const filter = new ConstantVelocityKalmanFilter();
    filter.process({ latitude: 0, longitude: 0, accuracyM: 5, timestampMs: 1_000 });

    const result = filter.process({ latitude: 0.001, longitude: 0, accuracyM: 5, timestampMs: 31_001 });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.reset).toBe(true);
    expect(result.location.speedMps).toBe(0);
    expect(result.location.latitude).toBe(0.001);
  });

  it('snaps to a route candidate within 20 metres and 35 degrees of heading', () => {
    const filter = new ConstantVelocityKalmanFilter();
    const result = filter.process(
      { latitude: 0, longitude: 0, accuracyM: 5, timestampMs: 1_000, bearingDeg: 1 },
      { latitude: 0.00009, longitude: 0, bearingDeg: 359 },
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.location.snappedToRoute).toBe(true);
    expect(result.location.latitude).toBe(0.00009);
  });

  it('rejects malformed and out-of-order fixes', () => {
    const filter = new ConstantVelocityKalmanFilter();
    expect(filter.process({ latitude: 91, longitude: 0, accuracyM: 5, timestampMs: 1_000 })).toMatchObject({
      accepted: false,
      reason: 'invalid_fix',
    });
    filter.process({ latitude: 0, longitude: 0, accuracyM: 5, timestampMs: 2_000 });
    expect(filter.process({ latitude: 0, longitude: 0, accuracyM: 5, timestampMs: 2_000 })).toEqual({
      accepted: false,
      reason: 'out_of_order',
    });
  });
});
