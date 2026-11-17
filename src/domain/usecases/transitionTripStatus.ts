import { compareTripStatus, type TripStatus } from '../entities/TripStatus.ts';

const NEXT_STATUSES: Partial<Record<TripStatus, readonly TripStatus[]>> = {
  EN_ROUTE_TO_PICKUP: ['ARRIVED_AT_PICKUP'],
  ARRIVED_AT_PICKUP: ['ON_TRIP'],
  ON_TRIP: ['COMPLETED'],
};

/** Returns whether a requested trip transition follows the PRD lifecycle. */
export function canTransitionTripStatus(
  current: TripStatus,
  next: TripStatus,
): boolean {
  if (current === next) return true;
  if (next === 'CANCELLED') return true;
  return NEXT_STATUSES[current]?.includes(next) ?? false;
}

/**
 * Applies a valid local transition. Invalid transitions return null so callers
 * can show an error without mutating persisted trip state.
 */
export function transitionTripStatus(
  current: TripStatus,
  next: TripStatus,
): TripStatus | null {
  return canTransitionTripStatus(current, next) ? next : null;
}

/** Max-register merge required by the PRD; cancellation has ordinal 99. */
export function mergeTripStatus(
  local: TripStatus,
  remote: TripStatus,
): TripStatus {
  return compareTripStatus(local, remote) >= 0 ? local : remote;
}
