import {
  canTransitionTripStatus,
  mergeTripStatus,
  transitionTripStatus,
} from '../../src/domain/usecases/transitionTripStatus';

describe('trip lifecycle', () => {
  it('allows each forward trip lifecycle transition', () => {
    expect(
      transitionTripStatus('EN_ROUTE_TO_PICKUP', 'ARRIVED_AT_PICKUP'),
    ).toBe('ARRIVED_AT_PICKUP');
    expect(transitionTripStatus('ARRIVED_AT_PICKUP', 'ON_TRIP')).toBe(
      'ON_TRIP',
    );
    expect(transitionTripStatus('ON_TRIP', 'COMPLETED')).toBe('COMPLETED');
  });

  it('rejects skipped, backward, and post-completion transitions', () => {
    expect(canTransitionTripStatus('EN_ROUTE_TO_PICKUP', 'ON_TRIP')).toBe(
      false,
    );
    expect(transitionTripStatus('ON_TRIP', 'ARRIVED_AT_PICKUP')).toBeNull();
    expect(transitionTripStatus('COMPLETED', 'ON_TRIP')).toBeNull();
  });

  it('allows cancellation from every lifecycle state', () => {
    const states = [
      'EN_ROUTE_TO_PICKUP',
      'ARRIVED_AT_PICKUP',
      'ON_TRIP',
      'COMPLETED',
    ] as const;

    for (const state of states) {
      expect(transitionTripStatus(state, 'CANCELLED')).toBe('CANCELLED');
    }
  });

  it('merges the more advanced state and cancellation wins', () => {
    expect(
      mergeTripStatus('EN_ROUTE_TO_PICKUP', 'ARRIVED_AT_PICKUP'),
    ).toBe('ARRIVED_AT_PICKUP');
    expect(
      mergeTripStatus('ARRIVED_AT_PICKUP', 'EN_ROUTE_TO_PICKUP'),
    ).toBe('ARRIVED_AT_PICKUP');
    expect(mergeTripStatus('COMPLETED', 'CANCELLED')).toBe('CANCELLED');
  });

  it('merges each status idempotently', () => {
    const states = [
      'EN_ROUTE_TO_PICKUP',
      'ARRIVED_AT_PICKUP',
      'ON_TRIP',
      'COMPLETED',
      'CANCELLED',
    ] as const;

    for (const state of states) {
      expect(mergeTripStatus(state, state)).toBe(state);
    }
  });
});
