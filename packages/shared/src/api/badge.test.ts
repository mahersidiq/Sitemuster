import { describe, expect, it } from 'vitest';

import { BadgePayloadSchema, badgeTimeStep, parseBadgePayload } from './badge.ts';

const device = '33333333-3333-4333-8333-333333333333';
const project = '00000000-0000-4000-8000-000000000001';

describe('offline badge payload (decision #43)', () => {
  it('matches the exact SMB1 regex from the API contract', () => {
    const payload = `SMB1.${device}.${project}.59000000.AbCdEfGhIjKlMnOpQrStUv`;
    expect(BadgePayloadSchema.safeParse(payload).success).toBe(true);
    expect(parseBadgePayload(payload)).toEqual({
      deviceId: device,
      projectId: project,
      timeStep: 59000000,
      mac: 'AbCdEfGhIjKlMnOpQrStUv',
    });
  });

  it.each([
    ['wrong prefix', `SMB2.${device}.${project}.59000000.AbCdEfGhIjKlMnOpQrStUv`],
    ['short mac', `SMB1.${device}.${project}.59000000.AbCdEfGhIjKlMnOpQrStU`],
    ['short step', `SMB1.${device}.${project}.5900000.AbCdEfGhIjKlMnOpQrStUv`],
    [
      'uppercase uuid',
      `SMB1.ABCDEF12-3333-4333-8333-333333333333.${project}.59000000.AbCdEfGhIjKlMnOpQrStUv`,
    ],
    ['trailing data', `SMB1.${device}.${project}.59000000.AbCdEfGhIjKlMnOpQrStUv.x`],
  ])('rejects %s', (_label, payload) => {
    expect(BadgePayloadSchema.safeParse(payload).success).toBe(false);
    expect(parseBadgePayload(payload)).toBeNull();
  });

  it('derives 30-second time steps', () => {
    expect(badgeTimeStep(0)).toBe(0);
    expect(badgeTimeStep(29)).toBe(0);
    expect(badgeTimeStep(30)).toBe(1);
    expect(badgeTimeStep(1_762_171_200)).toBe(58_739_040);
  });
});
