import { isValidCell, getResolution } from 'h3-js';
import { describe, expect, it } from 'vitest';
import { buildScenarioMessages, encodePolyline, listScenarios, SCENARIO_ID } from '../src/scenario.js';

describe('synthetic drive scenario', () => {
  it('describes a repeatable Bengaluru demo drive', () => {
    expect(listScenarios()).toEqual([expect.objectContaining({ id: SCENARIO_ID, pointCount: 11, messageCount: 17, cityId: 'blr' })]);
  });

  it('generates valid resolution-8 H3 cells and versioned surge deltas', () => {
    const messages = buildScenarioMessages('trip-test', 1_000_000);
    const surge = messages.filter(message => message.type === 'pricing.surge');
    expect(surge).toHaveLength(5);
    for (const message of surge) {
      const payload = message.payload as { h3Res: number; layerVersion: number; baseVersion: number; changed: Array<{ h3: string; mult: number }> };
      expect(payload.h3Res).toBe(8);
      expect(payload.baseVersion).toBe(payload.layerVersion - 1);
      for (const cell of payload.changed) {
        expect(isValidCell(cell.h3)).toBe(true);
        expect(getResolution(cell.h3)).toBe(8);
        expect(cell.mult).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('encodes route coordinates as a Google precision-5 polyline', () => {
    expect(encodePolyline([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ])).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });
});

