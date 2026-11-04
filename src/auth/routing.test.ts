import { describe, expect, it } from 'vitest';

import type { Access } from './access';
import {
  canOpenStaffShell,
  canOpenWorkerShell,
  deriveAuthState,
  routeFor,
  type Assurance,
} from './routing';

const base: Access = {
  user_id: '11111111-1111-4111-8111-111111111111',
  aal: 'aal1',
  email_verified: false,
  phone_verified: true,
  is_platform_operator: false,
  account_deletion_pending: false,
  worker_profile_id: null,
  is_foreman: false,
  org_roles: [],
  project_roles: [],
};
const aal1: Assurance = { current: 'aal1', next: 'aal1' };
const aal1Next2: Assurance = { current: 'aal1', next: 'aal2' };
const aal2: Assurance = { current: 'aal2', next: 'aal2' };
const staff: Access = {
  ...base,
  email_verified: true,
  phone_verified: false,
  project_roles: [{ project_id: '22222222-2222-4222-8222-222222222222', role: 'SUPER' }],
};

const derive = (
  access: Access | null,
  assurance: Assurance,
  factors: string[] = [],
  hasSession = true,
) => deriveAuthState({ hasSession, access, assurance, verifiedTotpFactorIds: factors });

describe('deriveAuthState', () => {
  it('is signed out without a session', () => {
    expect(derive(base, aal1, [], false)).toEqual({ status: 'signed_out' });
  });

  it('lets a phone worker in at aal1 (no MFA for workers)', () => {
    expect(derive(base, aal1).status).toBe('signed_in');
  });

  it('forces staff without an authenticator into enrollment', () => {
    expect(derive(staff, aal1).status).toBe('needs_mfa_enroll');
  });

  it('forces an email-path user with no roles into enrollment too', () => {
    expect(derive({ ...base, email_verified: true, phone_verified: false }, aal1).status).toBe(
      'needs_mfa_enroll',
    );
  });

  it('requires the TOTP challenge when a factor exists and the session is aal1', () => {
    expect(derive(staff, aal1Next2, ['f1'])).toMatchObject({
      status: 'needs_mfa_verify',
      factorId: 'f1',
    });
  });

  it('signs staff in only at aal2', () => {
    expect(derive(staff, aal2, ['f1']).status).toBe('signed_in');
  });
});

describe('routeFor and guards', () => {
  it('asks for the language first', () => {
    expect(routeFor({ status: 'signed_out' }, false)).toBe('/language');
  });

  it.each([
    [{ status: 'signed_out' } as const, '/sign-in'],
    [{ status: 'unavailable' } as const, '/sign-in'],
    [{ status: 'offline' } as const, '/offline'],
  ])('routes %j to %s', (state, route) => {
    expect(routeFor(state, true)).toBe(route);
  });

  it('routes each signed-in shape', () => {
    expect(routeFor(derive(base, aal1), true)).toBe('/join');
    expect(routeFor(derive({ ...base, worker_profile_id: base.user_id }, aal1), true)).toBe(
      '/worker/home',
    );
    expect(routeFor(derive(staff, aal2, ['f']), true)).toBe('/staff/home');
    expect(routeFor(derive({ ...staff, worker_profile_id: base.user_id }, aal2, ['f']), true)).toBe(
      '/choose-context',
    );
    expect(
      routeFor(derive({ ...base, email_verified: true, phone_verified: false }, aal2, ['f']), true),
    ).toBe('/no-org');
    expect(routeFor(derive({ ...staff, is_platform_operator: true }, aal2, ['f']), true)).toBe(
      '/operator',
    );
  });

  it('never opens the staff shell below aal2', () => {
    expect(canOpenStaffShell(derive(staff, aal2, ['f']))).toBe(true);
    expect(canOpenStaffShell({ status: 'signed_in', access: staff, assurance: aal1 })).toBe(false);
    expect(canOpenWorkerShell(derive(base, aal1))).toBe(false);
    expect(canOpenWorkerShell(derive({ ...base, worker_profile_id: base.user_id }, aal1))).toBe(
      true,
    );
  });
});

describe('account deletion pending (decision #137)', () => {
  it('goes straight to the deletion screen, without an authenticator step, for staff and workers', () => {
    const deleting = { ...staff, account_deletion_pending: true };
    const state = derive(deleting, aal1, []);
    expect(state.status).toBe('signed_in');
    expect(routeFor(state, true)).toBe('/account/deletion-pending');
    const worker = derive({ ...base, account_deletion_pending: true }, aal1);
    expect(routeFor(worker, true)).toBe('/account/deletion-pending');
    // Even if a stale answer still carried roles, the shells stay closed.
    const stale = derive(
      {
        ...staff,
        worker_profile_id: '33333333-3333-4333-8333-333333333333',
        account_deletion_pending: true,
      },
      aal2,
      ['f1'],
    );
    expect(canOpenWorkerShell(stale)).toBe(false);
    expect(canOpenStaffShell(stale)).toBe(false);
    expect(routeFor(stale, true)).toBe('/account/deletion-pending');
  });
});
