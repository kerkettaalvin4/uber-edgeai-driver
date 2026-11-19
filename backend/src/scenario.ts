import { latLngToCell } from 'h3-js';

export const SCENARIO_ID = 'blr-short-drive-v1';

interface Coordinate {
  lat: number;
  lng: number;
}

export interface ScenarioMessage {
  type: 'telemetry.location.batch' | 'pricing.surge' | 'route.update';
  payload: Record<string, unknown>;
}

const ROUTE: Coordinate[] = [
  { lat: 12.971598, lng: 77.594566 },
  { lat: 12.971603, lng: 77.594671 },
  { lat: 12.9692, lng: 77.5981 },
  { lat: 12.9668, lng: 77.6027 },
  { lat: 12.9634, lng: 77.6079 },
  { lat: 12.9598, lng: 77.6126 },
  { lat: 12.9550, lng: 77.6174 },
  { lat: 12.9502, lng: 77.6204 },
  { lat: 12.9451, lng: 77.6220 },
  { lat: 12.9402, lng: 77.6231 },
  { lat: 12.935192, lng: 77.624480 },
];

export function listScenarios() {
  return [{
    id: SCENARIO_ID,
    name: 'Bengaluru short drive (synthetic)',
    description: 'A synthetic 11-point drive from central Bengaluru toward Koramangala with cycling resolution-8 surge updates and one route change.',
    pointCount: ROUTE.length,
    messageCount: ROUTE.length + Math.floor(ROUTE.length / 2) + 1,
    cityId: 'blr',
    h3Resolution: 8,
  }];
}

export function buildScenarioMessages(tripId: string, startedAt = Date.now(), driverId = 'driver-dev-001'): ScenarioMessage[] {
  const messages: ScenarioMessage[] = [];
  const cells = [...new Set(ROUTE.map(point => latLngToCell(point.lat, point.lng, 8)))];
  const sampleTimes = ROUTE.map((_, index) => startedAt + index * 1_000);

  ROUTE.forEach((point, index) => {
    const next = ROUTE[index + 1] ?? point;
    messages.push({
      type: 'telemetry.location.batch',
      payload: {
        driverId,
        tripId,
        deviceState: { batteryPct: 64, charging: false, thermal: 'nominal', network: 'cellular_4g', appState: 'foreground' },
        samplingMode: 'BALANCED',
        points: [{
          t: sampleTimes[index], lat: point.lat, lng: point.lng, accM: Number((5.2 + (index % 3) * 0.7).toFixed(1)),
          spdMps: Number((6.5 + (index % 4) * 1.4).toFixed(1)), brg: bearing(point, next),
          alt: Number((920 + index * 0.2).toFixed(1)), src: 'fused', flt: 'scenario_v1',
        }],
      },
    });

    if ((index + 1) % 2 === 0 && cells.length > 0) {
      const layerVersion = Math.floor((index + 1) / 2);
      const first = cells[(layerVersion - 1) % cells.length]!;
      const second = cells[layerVersion % cells.length]!;
      const removed = layerVersion > 1 ? [cells[(layerVersion - 2) % cells.length]!] : [];
      const multiplier = [1.2, 1.5, 1.8, 1.4][(layerVersion - 1) % 4]!;
      messages.push({
        type: 'pricing.surge',
        payload: {
          cityId: 'blr', h3Res: 8, layerVersion, baseVersion: layerVersion - 1,
          validUntil: startedAt + (layerVersion + 2) * 60_000,
          changed: [
            { h3: first, mult: multiplier, demandIdx: Number((0.55 + layerVersion * 0.05).toFixed(2)) },
            { h3: second, mult: Math.max(1.1, multiplier - 0.2), demandIdx: Number((0.48 + layerVersion * 0.04).toFixed(2)) },
          ],
          removed,
        },
      });
    }

    if (index === 5) {
      messages.push({
        type: 'route.update',
        payload: {
          tripId, routeVersion: 2, reason: 'scenario_recalculation', polyline: encodePolyline(ROUTE), precision: 5,
          distanceM: Math.round(routeDistanceMeters(ROUTE)), etaSec: 742,
          maneuvers: [{ idx: 3, type: 'turn_right', street: '100 Feet Rd', distM: 220 }],
        },
      });
    }
  });

  return messages;
}

export function encodePolyline(points: Coordinate[]): string {
  let previousLat = 0;
  let previousLng = 0;
  let encoded = '';
  for (const point of points) {
    const lat = Math.round(point.lat * 1e5);
    const lng = Math.round(point.lng * 1e5);
    encoded += encodeDelta(lat - previousLat) + encodeDelta(lng - previousLng);
    previousLat = lat;
    previousLng = lng;
  }
  return encoded;
}

function encodeDelta(value: number): string {
  let encoded = value < 0 ? -value * 2 - 1 : value * 2;
  let output = '';
  while (encoded >= 0x20) {
    output += String.fromCharCode(0x20 + (encoded % 0x20) + 63);
    encoded = Math.floor(encoded / 0x20);
  }
  return output + String.fromCharCode(encoded + 63);
}

function bearing(from: Coordinate, to: Coordinate): number {
  const radians = Math.PI / 180;
  const y = Math.sin((to.lng - from.lng) * radians) * Math.cos(to.lat * radians);
  const x = Math.cos(from.lat * radians) * Math.sin(to.lat * radians) - Math.sin(from.lat * radians) * Math.cos(to.lat * radians) * Math.cos((to.lng - from.lng) * radians);
  return Number(((Math.atan2(y, x) / radians + 360) % 360).toFixed(1));
}

function routeDistanceMeters(points: Coordinate[]): number {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const lat1 = previous.lat * Math.PI / 180;
    const lat2 = current.lat * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLng = (current.lng - previous.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    distance += 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return distance;
}

