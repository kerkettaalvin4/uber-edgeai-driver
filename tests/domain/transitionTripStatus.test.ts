import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTransitionTripStatus,
  mergeTripStatus,
  transitionTripStatus,
} from '../../src/domain/usecases/transitionTripStatus.ts';

test('allows each forward trip lifecycle transition', () => {
  assert.equal(transitionTripStatus('EN_ROUTE_TO_PICKUP', 'ARRIVED_AT_PICKUP'), 'ARRIVED_AT_PICKUP');
  assert.equal(transitionTripStatus('ARRIVED_AT_PICKUP', 'ON_TRIP'), 'ON_TRIP');
  assert.equal(transitionTripStatus('ON_TRIP', 'COMPLETED'), 'COMPLETED');
});

test('rejects skipped, backward, and post-completion transitions', () => {
  assert.equal(canTransitionTripStatus('EN_ROUTE_TO_PICKUP', 'ON_TRIP'), false);
  assert.equal(transitionTripStatus('ON_TRIP', 'ARRIVED_AT_PICKUP'), null);
  assert.equal(transitionTripStatus('COMPLETED', 'ON_TRIP'), null);
});

test('allows cancellation from every lifecycle state', () => {
  const states = [
    'EN_ROUTE_TO_PICKUP',
    'ARRIVED_AT_PICKUP',
    'ON_TRIP',
    'COMPLETED',
  ] as const;

  for (const state of states) {
    assert.equal(transitionTripStatus(state, 'CANCELLED'), 'CANCELLED');
  }
});

test('merges the more advanced state and cancellation wins', () => {
  assert.equal(mergeTripStatus('EN_ROUTE_TO_PICKUP', 'ARRIVED_AT_PICKUP'), 'ARRIVED_AT_PICKUP');
  assert.equal(mergeTripStatus('ARRIVED_AT_PICKUP', 'EN_ROUTE_TO_PICKUP'), 'ARRIVED_AT_PICKUP');
  assert.equal(mergeTripStatus('COMPLETED', 'CANCELLED'), 'CANCELLED');
});

test('merge is idempotent', () => {
  const states = [
    'EN_ROUTE_TO_PICKUP',
    'ARRIVED_AT_PICKUP',
    'ON_TRIP',
    'COMPLETED',
    'CANCELLED',
  ] as const;

  for (const state of states) {
    assert.equal(mergeTripStatus(state, state), state);
  }
});
