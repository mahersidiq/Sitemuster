import type { SupabaseClient } from '@supabase/supabase-js';

import type { Locale } from '@sitemuster/shared';

import { AccessSchema, type Access } from './access';
import { mapAuthError, retryAfterSeconds, type AuthErrorKind } from './auth-errors';
import type { Assurance } from './routing';

export type AuthResult =
  { ok: true } | { ok: false; error: AuthErrorKind; retryAfter: number | null };

export interface TotpEnrollment {
  factorId: string;
  uri: string;
  secret: string;
}

/** Everything the app needs from the authentication backend (tests use a typed double). */
export interface AuthGateway {
  hasSession(): Promise<boolean>;
  onChange(listener: () => void): () => void;
  requestPhoneCode(phoneE164: string): Promise<AuthResult>;
  verifyPhoneCode(phoneE164: string, code: string): Promise<AuthResult>;
  requestEmailCode(email: string): Promise<AuthResult>;
  verifyEmailCode(email: string, code: string): Promise<AuthResult>;
  assurance(): Promise<Assurance>;
  verifiedTotpFactorIds(): Promise<string[]>;
  enrollTotp(): Promise<TotpEnrollment | { error: AuthErrorKind }>;
  verifyTotp(factorId: string, code: string): Promise<AuthResult>;
  fetchAccess(): Promise<Access>;
  saveLanguage(locale: Locale): Promise<void>;
  signOut(): Promise<void>;
}

function toLevel(level: string | null | undefined): 'aal1' | 'aal2' | null {
  return level === 'aal1' || level === 'aal2' ? level : null;
}

function failure(error: {
  status?: number;
  code?: string;
  name?: string;
  message?: string;
}): AuthResult {
  return { ok: false, error: mapAuthError(error), retryAfter: retryAfterSeconds(error) };
}

export class SupabaseAuthGateway implements AuthGateway {
  constructor(private readonly client: SupabaseClient) {}

  async hasSession(): Promise<boolean> {
    const { data } = await this.client.auth.getSession();
    return data.session !== null;
  }

  onChange(listener: () => void): () => void {
    const { data } = this.client.auth.onAuthStateChange(() => listener());
    return () => data.subscription.unsubscribe();
  }

  async requestPhoneCode(phone: string): Promise<AuthResult> {
    const { error } = await this.client.auth.signInWithOtp({
      phone,
      options: { shouldCreateUser: true },
    });
    return error ? failure(error) : { ok: true };
  }

  async verifyPhoneCode(phone: string, token: string): Promise<AuthResult> {
    const { error } = await this.client.auth.verifyOtp({ phone, token, type: 'sms' });
    return error ? failure(error) : { ok: true };
  }

  async requestEmailCode(email: string): Promise<AuthResult> {
    const { error } = await this.client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    return error ? failure(error) : { ok: true };
  }

  async verifyEmailCode(email: string, token: string): Promise<AuthResult> {
    const { error } = await this.client.auth.verifyOtp({ email, token, type: 'email' });
    return error ? failure(error) : { ok: true };
  }

  async assurance(): Promise<Assurance> {
    const { data } = await this.client.auth.mfa.getAuthenticatorAssuranceLevel();
    return { current: toLevel(data?.currentLevel), next: toLevel(data?.nextLevel) };
  }

  async verifiedTotpFactorIds(): Promise<string[]> {
    const { data } = await this.client.auth.mfa.listFactors();
    return (data?.totp ?? [])
      .filter((factor) => factor.status === 'verified')
      .map((factor) => factor.id);
  }

  async enrollTotp(): Promise<TotpEnrollment | { error: AuthErrorKind }> {
    // Abandoned (never verified) enrollments would otherwise exhaust the factor limit.
    const { data: factors } = await this.client.auth.mfa.listFactors();
    for (const factor of factors?.all ?? []) {
      if (factor.status === 'unverified')
        await this.client.auth.mfa.unenroll({ factorId: factor.id });
    }
    const { data, error } = await this.client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `SiteMuster ${new Date().toISOString().slice(0, 10)}`,
    });
    if (error || !data) return { error: mapAuthError(error) };
    return { factorId: data.id, uri: data.totp.uri, secret: data.totp.secret };
  }

  async verifyTotp(factorId: string, code: string): Promise<AuthResult> {
    const challenge = await this.client.auth.mfa.challenge({ factorId });
    if (challenge.error || !challenge.data) return failure(challenge.error ?? {});
    const { error } = await this.client.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code,
    });
    return error ? failure(error) : { ok: true };
  }

  async fetchAccess(): Promise<Access> {
    const { data, error } = await this.client.rpc('get_my_access');
    if (error) throw new Error(`access lookup failed (${error.code ?? 'unknown'})`);
    return AccessSchema.parse(data);
  }

  async saveLanguage(locale: Locale): Promise<void> {
    await this.client.auth.updateUser({ data: { locale } });
    const { error } = await this.client.rpc('set_my_language', { p_locale: locale });
    if (error) throw new Error(`language save failed (${error.code ?? 'unknown'})`);
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }
}
