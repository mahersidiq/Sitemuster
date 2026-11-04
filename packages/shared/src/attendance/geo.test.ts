import { describe, expect, it } from 'vitest';

import { classifyZone, distanceMeters, isImplausibleJump } from './geo.ts';
import { selectNativeRegions } from './regions.ts';

const CENTER = { lat: 29.7604, lng: -95.3698 };
const north = (m: number) => ({ lat: CENTER.lat + m / 111195, lng: CENTER.lng });
const site = { center: CENTER, radiusM: 150, exitHysteresisM: 50 };

describe('site geometry', () => {
  it('measures distances on the sphere', () => {
    expect(distanceMeters(CENTER, north(1000))).toBeCloseTo(1000, 0);
  });

  it('splits inside / boundary band / outside at the site radius and the native fence', () => {
    expect(classifyZone(north(149), site)).toBe('INNER');
    expect(classifyZone(north(151), site)).toBe('BAND');
    expect(classifyZone(north(199), site)).toBe('BAND');
    expect(classifyZone(north(201), site)).toBe('OUTSIDE');
  });

  it('flags implausible jumps but tolerates GPS noise', () => {
    const a = { ...north(-140), accuracyM: 5, at: 0 };
    expect(isImplausibleJump(a, { ...north(140), accuracyM: 5, at: 2000 })).toBe(true);
    expect(isImplausibleJump(a, { ...north(140), accuracyM: 5, at: 60_000 })).toBe(false);
    expect(isImplausibleJump(a, { ...north(-100), accuracyM: 30, at: 1000 })).toBe(false);
  });
});

describe('native region budget', () => {
  it('monitors the active project first, then the nearest, then upcoming shifts', () => {
    const picked = selectNativeRegions(
      [
        { projectId: 'far', distanceM: 9000, activeSession: false, nextShiftInMs: 0 },
        { projectId: 'near', distanceM: 100, activeSession: false, nextShiftInMs: null },
        { projectId: 'active', distanceM: 20000, activeSession: true, nextShiftInMs: null },
        { projectId: 'unknown', distanceM: null, activeSession: false, nextShiftInMs: 1000 },
      ],
      2,
    );
    expect(picked).toEqual({ monitored: ['active', 'near'], unmonitored: ['far', 'unknown'] });
  });
});
