import { hasStaffRole, isStaffCandidate, type Access } from './access';

export type Assurance = { current: 'aal1' | 'aal2' | null; next: 'aal1' | 'aal2' | null };

export type AuthState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'signed_out' }
  | { status: 'needs_mfa_enroll'; access: Access }
  | { status: 'needs_mfa_verify'; access: Access; factorId: string }
  | { status: 'offline' }
  | { status: 'signed_in'; access: Access; assurance: Assurance; accessIsStale?: boolean };

/**
 * Pure derivation of the auth state from what the server reports. Staff (and email-path users)
 * must reach aal2 with a verified authenticator before any staff screen opens (decision #3).
 */
export function deriveAuthState(input: {
  hasSession: boolean;
  access: Access | null;
  assurance: Assurance;
  verifiedTotpFactorIds: string[];
}): AuthState {
  if (!input.hasSession || !input.access) return { status: 'signed_out' };
  const { access, assurance } = input;
  // Being deleted: nothing is open to this person, so no authenticator step first either.
  if (access.is_platform_operator || access.account_deletion_pending) {
    return { status: 'signed_in', access, assurance };
  }
  const firstFactor = input.verifiedTotpFactorIds[0];
  if (assurance.current === 'aal1' && assurance.next === 'aal2' && firstFactor) {
    return { status: 'needs_mfa_verify', access, factorId: firstFactor };
  }
  if (isStaffCandidate(access) && assurance.current !== 'aal2' && !firstFactor) {
    return { status: 'needs_mfa_enroll', access };
  }
  return { status: 'signed_in', access, assurance };
}

export type AppRoute =
  | '/language'
  | '/sign-in'
  | '/auth/mfa-enroll'
  | '/auth/mfa-verify'
  | '/worker/home'
  | '/staff/home'
  | '/choose-context'
  | '/join'
  | '/no-org'
  | '/operator'
  | '/account/deletion-pending'
  | '/offline';

/** Where the entry screen sends the user. */
export function routeFor(state: AuthState, languageChosen: boolean): AppRoute | null {
  if (!languageChosen) return '/language';
  switch (state.status) {
    case 'loading':
      return null;
    case 'unavailable':
    case 'signed_out':
      return '/sign-in';
    case 'offline':
      return '/offline';
    case 'needs_mfa_enroll':
      return '/auth/mfa-enroll';
    case 'needs_mfa_verify':
      return '/auth/mfa-verify';
    case 'signed_in': {
      const { access, assurance } = state;
      if (access.account_deletion_pending) return '/account/deletion-pending';
      if (access.is_platform_operator) return '/operator';
      const staff = hasStaffRole(access) && assurance.current === 'aal2';
      if (staff && access.worker_profile_id) return '/choose-context';
      if (staff) return '/staff/home';
      if (access.worker_profile_id) return '/worker/home';
      if (isStaffCandidate(access)) return '/no-org';
      return '/join';
    }
  }
}

/** Route guards: the server enforces data access independently; these only pick screens. */
export function canOpenStaffShell(state: AuthState): boolean {
  return (
    state.status === 'signed_in' &&
    !state.access.account_deletion_pending &&
    hasStaffRole(state.access) &&
    state.assurance.current === 'aal2'
  );
}

export function canOpenWorkerShell(state: AuthState): boolean {
  return (
    state.status === 'signed_in' &&
    !state.access.account_deletion_pending &&
    state.access.worker_profile_id !== null
  );
}

/** Verified staff e-mail at aal2 may create an organization (server re-checks everything). */
export function canCreateOrganization(state: AuthState): boolean {
  return (
    state.status === 'signed_in' &&
    !state.access.is_platform_operator &&
    state.access.email_verified &&
    state.assurance.current === 'aal2'
  );
}

/** Organizations where the user is OWNER/ADMIN (may create projects; server re-checks). */
export function managedOrganizationIds(state: AuthState): string[] {
  if (state.status !== 'signed_in') return [];
  return state.access.org_roles.map((role) => role.organization_id);
}

export function ownedOrganizationIds(state: AuthState): string[] {
  if (state.status !== 'signed_in') return [];
  return state.access.org_roles
    .filter((role) => role.role === 'OWNER')
    .map((role) => role.organization_id);
}
