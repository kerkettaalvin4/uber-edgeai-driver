/** Trip lifecycle states from PRD MPE-INT-PRD-2026-14, Section 4.3. */
export const TRIP_STATUS_ORDINAL = {
  EN_ROUTE_TO_PICKUP: 2,
  ARRIVED_AT_PICKUP: 3,
  ON_TRIP: 4,
  COMPLETED: 5,
  CANCELLED: 99,
} as const;

export type TripStatus = keyof typeof TRIP_STATUS_ORDINAL;

export function compareTripStatus(left: TripStatus, right: TripStatus): number {
  return TRIP_STATUS_ORDINAL[left] - TRIP_STATUS_ORDINAL[right];
}
