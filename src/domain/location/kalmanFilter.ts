const EARTH_RADIUS_M = 6_378_137;
const MAX_ACCURACY_M = 50;
const MAX_SPEED_MPS = 55;
const RESET_GAP_MS = 30_000;
const SLOW_ACCELERATION_NOISE = 1.5;
const FAST_ACCELERATION_NOISE = 3;

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  timestampMs: number;
  bearingDeg?: number;
}

/** One candidate point on the route, produced by the route/map adapter. */
export interface RouteSnapCandidate {
  latitude: number;
  longitude: number;
  bearingDeg: number;
}

export interface FilteredLocation {
  latitude: number;
  longitude: number;
  eastVelocityMps: number;
  northVelocityMps: number;
  speedMps: number;
  timestampMs: number;
  snappedToRoute: boolean;
}

export type LocationFilterResult =
  | { accepted: true; location: FilteredLocation; reset: boolean }
  | { accepted: false; reason: 'invalid_fix' | 'poor_accuracy' | 'out_of_order' | 'impossible_speed' };

type Point = { east: number; north: number };
type Matrix = number[][];

/**
 * Constant-velocity Kalman filter in a local east/north coordinate system.
 * This is a pure domain class: callers supply fixes and time explicitly.
 */
export class ConstantVelocityKalmanFilter {
  private anchor: { latitudeRad: number; longitudeRad: number } | null = null;
  private state: number[] | null = null; // east, north, east velocity, north velocity
  private covariance: Matrix | null = null;
  private lastFix: LocationFix | null = null;

  process(fix: LocationFix, routeSnap?: RouteSnapCandidate): LocationFilterResult {
    if (!isValidFix(fix)) return { accepted: false, reason: 'invalid_fix' };
    if (fix.accuracyM > MAX_ACCURACY_M) return { accepted: false, reason: 'poor_accuracy' };
    if (this.lastFix && fix.timestampMs <= this.lastFix.timestampMs) {
      return { accepted: false, reason: 'out_of_order' };
    }

    const gapMs = this.lastFix ? fix.timestampMs - this.lastFix.timestampMs : 0;
    const mustReset = this.state === null || gapMs > RESET_GAP_MS;
    if (!mustReset && this.lastFix && gapMs > 0) {
      const impliedSpeed = distanceMeters(this.lastFix, fix) / (gapMs / 1000);
      if (impliedSpeed > MAX_SPEED_MPS) {
        return { accepted: false, reason: 'impossible_speed' };
      }
    }

    if (mustReset) this.initialize(fix);
    else this.update(fix, gapMs / 1000);

    this.lastFix = { ...fix };
    const state = this.state!;
    const point = fromLocalEnu({ east: state[0], north: state[1] }, this.anchor!);
    const snapped = routeSnap ? snapToRoute(point, fix.bearingDeg, routeSnap) : null;
    return {
      accepted: true,
      reset: mustReset,
      location: {
        latitude: snapped?.latitude ?? point.latitude,
        longitude: snapped?.longitude ?? point.longitude,
        eastVelocityMps: state[2],
        northVelocityMps: state[3],
        speedMps: Math.hypot(state[2], state[3]),
        timestampMs: fix.timestampMs,
        snappedToRoute: snapped !== null,
      },
    };
  }

  reset(): void {
    this.anchor = null;
    this.state = null;
    this.covariance = null;
    this.lastFix = null;
  }

  private initialize(fix: LocationFix): void {
    this.anchor = {
      latitudeRad: degreesToRadians(fix.latitude),
      longitudeRad: degreesToRadians(fix.longitude),
    };
    this.state = [0, 0, 0, 0];
    const positionVariance = fix.accuracyM ** 2;
    this.covariance = diagonalMatrix([
      positionVariance,
      positionVariance,
      25,
      25,
    ]);
  }

  private update(fix: LocationFix, deltaSeconds: number): void {
    const state = this.state!;
    const covariance = this.covariance!;
    const measurement = toLocalEnu(fix, this.anchor!);
    const transition = [
      [1, 0, deltaSeconds, 0],
      [0, 1, 0, deltaSeconds],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];

    const predictedState = [
      state[0] + deltaSeconds * state[2],
      state[1] + deltaSeconds * state[3],
      state[2],
      state[3],
    ];

    const currentSpeed = Math.hypot(state[2], state[3]);
    const accelerationNoise = currentSpeed > 15
      ? FAST_ACCELERATION_NOISE
      : SLOW_ACCELERATION_NOISE;
    const processNoise = makeProcessNoise(deltaSeconds, accelerationNoise ** 2);
    const predictedCovariance = addMatrices(
      multiplyMatrices(multiplyMatrices(transition, covariance), transpose(transition)),
      processNoise,
    );

    const measurementVariance = fix.accuracyM ** 2;
    const s00 = predictedCovariance[0][0] + measurementVariance;
    const s01 = predictedCovariance[0][1];
    const s10 = predictedCovariance[1][0];
    const s11 = predictedCovariance[1][1] + measurementVariance;
    const determinant = s00 * s11 - s01 * s10;
    const inverseS = [
      [s11 / determinant, -s01 / determinant],
      [-s10 / determinant, s00 / determinant],
    ];

    const gain = predictedCovariance.map(row => [
      row[0] * inverseS[0][0] + row[1] * inverseS[1][0],
      row[0] * inverseS[0][1] + row[1] * inverseS[1][1],
    ]);
    const residual = [measurement.east - predictedState[0], measurement.north - predictedState[1]];
    this.state = predictedState.map((value, index) =>
      value + gain[index][0] * residual[0] + gain[index][1] * residual[1]);

    // Joseph covariance update is more numerically stable than (I-KH)P.
    const residualProjection = identityMatrix(4);
    for (let row = 0; row < 4; row += 1) {
      residualProjection[row][0] -= gain[row][0];
      residualProjection[row][1] -= gain[row][1];
    }
    const projected = multiplyMatrices(
      multiplyMatrices(residualProjection, predictedCovariance),
      transpose(residualProjection),
    );
    const measurementContribution = gain.map(left =>
      gain.map(right => measurementVariance * (
        left[0] * right[0] + left[1] * right[1]
      )),
    );
    this.covariance = addMatrices(projected, measurementContribution);
  }
}

function isValidFix(fix: LocationFix): boolean {
  return Number.isFinite(fix.latitude)
    && fix.latitude >= -90
    && fix.latitude <= 90
    && Number.isFinite(fix.longitude)
    && fix.longitude >= -180
    && fix.longitude <= 180
    && Number.isFinite(fix.accuracyM)
    && fix.accuracyM > 0
    && Number.isSafeInteger(fix.timestampMs)
    && (fix.bearingDeg === undefined || Number.isFinite(fix.bearingDeg));
}

function toLocalEnu(point: Pick<LocationFix, 'latitude' | 'longitude'>, anchor: { latitudeRad: number; longitudeRad: number }): Point {
  const latitudeRad = degreesToRadians(point.latitude);
  const longitudeRad = degreesToRadians(point.longitude);
  const deltaLongitude = normalizeRadians(longitudeRad - anchor.longitudeRad);
  return {
    east: EARTH_RADIUS_M * deltaLongitude * Math.cos(anchor.latitudeRad),
    north: EARTH_RADIUS_M * (latitudeRad - anchor.latitudeRad),
  };
}

function fromLocalEnu(point: Point, anchor: { latitudeRad: number; longitudeRad: number }): { latitude: number; longitude: number } {
  const cosineLatitude = Math.cos(anchor.latitudeRad);
  const latitudeRad = anchor.latitudeRad + point.north / EARTH_RADIUS_M;
  const longitudeRad = anchor.longitudeRad + point.east / (EARTH_RADIUS_M * cosineLatitude);
  return {
    latitude: radiansToDegrees(latitudeRad),
    longitude: ((radiansToDegrees(longitudeRad) + 540) % 360) - 180,
  };
}

function snapToRoute(
  filtered: { latitude: number; longitude: number },
  headingDeg: number | undefined,
  candidate: RouteSnapCandidate,
): { latitude: number; longitude: number } | null {
  if (!isValidCoordinate(candidate.latitude, candidate.longitude)
    || !Number.isFinite(candidate.bearingDeg)
    || headingDeg === undefined) return null;
  const gap = distanceMeters(filtered, candidate);
  const bearingGap = angularDifference(headingDeg, candidate.bearingDeg);
  return gap <= 20 && bearingGap < 35
    ? { latitude: candidate.latitude, longitude: candidate.longitude }
    : null;
}

function distanceMeters(left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }): number {
  const latitudeDelta = degreesToRadians(right.latitude - left.latitude);
  const longitudeDelta = normalizeRadians(degreesToRadians(right.longitude - left.longitude));
  const leftLatitude = degreesToRadians(left.latitude);
  const rightLatitude = degreesToRadians(right.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function makeProcessNoise(deltaSeconds: number, accelerationVariance: number): Matrix {
  const dt2 = deltaSeconds ** 2;
  const dt3 = deltaSeconds ** 3;
  const dt4 = deltaSeconds ** 4;
  const qPosition = accelerationVariance * dt4 / 4;
  const qCross = accelerationVariance * dt3 / 2;
  const qVelocity = accelerationVariance * dt2;
  return [
    [qPosition, 0, qCross, 0],
    [0, qPosition, 0, qCross],
    [qCross, 0, qVelocity, 0],
    [0, qCross, 0, qVelocity],
  ];
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return left.map(row => right[0].map((_, column) =>
    row.reduce((sum, value, index) => sum + value * right[index][column], 0)));
}

function addMatrices(left: Matrix, right: Matrix): Matrix {
  return left.map((row, i) => row.map((value, j) => value + right[i][j]));
}

function transpose(matrix: Matrix): Matrix {
  return matrix[0].map((_, column) => matrix.map(row => row[column]));
}

function diagonalMatrix(values: number[]): Matrix {
  return values.map((value, row) => values.map((_, column) => row === column ? value : 0));
}

function identityMatrix(size: number): Matrix {
  return diagonalMatrix(Array.from({ length: size }, () => 1));
}

function isValidCoordinate(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function angularDifference(left: number, right: number): number {
  return Math.abs(((left - right + 540) % 360) - 180);
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

function normalizeRadians(radians: number): number {
  return ((radians + Math.PI) % (2 * Math.PI) + (2 * Math.PI)) % (2 * Math.PI) - Math.PI;
}
