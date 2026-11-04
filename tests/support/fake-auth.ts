import { randomBytes } from 'node:crypto';

import type { Locale } from '@sitemuster/shared';

import type { SiteMusterApi } from '../../src/api/types';
import type { Access } from '../../src/auth/access';
import type { AuthErrorKind } from '../../src/auth/auth-errors';
import {
  EncryptedSessionStorage,
  type KeyStore,
  type KeyValueTable,
} from '../../src/auth/encrypted-storage';
import type { AuthGateway, AuthResult, TotpEnrollment } from '../../src/auth/gateway';
import type { Assurance } from '../../src/auth/routing';

/**
 * Typed test double of the authentication backend for Jest screen-flow tests. It mirrors the
 * real contract (cooldown, single-use codes, aal1 → aal2) without any network. Real Supabase Auth
 * behaviour is covered separately by tests/backend against the local Auth server.
 */
export const FAKE_SMS_CODE = '135790';
export const FAKE_EMAIL_CODE = '246802';
export const FAKE_TOTP_CODE = '975310';

function memoryTable(): KeyValueTable {
  const rows = new Map<string, string>();
  return {
    get: async (k) => rows.get(k) ?? null,
    set: async (k, v) => {
      rows.set(k, v);
    },
    remove: async (k) => {
      rows.delete(k);
    },
    keys: async () => [...rows.keys()],
    clear: async () => rows.clear(),
  };
}

function memoryKeys(): KeyStore {
  let value: string | null = null;
  return {
    read: async () => value,
    write: async (v) => {
      value = v;
    },
    delete: async () => {
      value = null;
    },
  };
}

export class FakeAuthGateway implements AuthGateway {
  session: { destination: string } | null = null;
  aal: 'aal1' | 'aal2' = 'aal1';
  factors: string[] = [];
  offline = false;
  smsDown = false;
  readonly savedLanguages: Locale[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, { code: string; at: number }>();

  constructor(private readonly accessFor: (destination: string) => Access) {}

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private request(destination: string, code: string): AuthResult {
    const last = this.pending.get(destination);
    if (last && Date.now() - last.at < 60_000) {
      return {
        ok: false,
        error: 'RATE_LIMITED',
        retryAfter: Math.ceil((60_000 - (Date.now() - last.at)) / 1000),
      };
    }
    this.pending.set(destination, { code, at: Date.now() });
    return { ok: true };
  }

  private verify(destination: string, code: string): AuthResult {
    const pending = this.pending.get(destination);
    if (!pending || pending.code !== code)
      return { ok: false, error: 'INVALID_OR_EXPIRED_CODE', retryAfter: null };
    this.pending.delete(destination);
    this.session = { destination };
    this.aal = 'aal1';
    this.emit();
    return { ok: true };
  }

  async hasSession() {
    return this.session !== null;
  }

  async sessionUserId() {
    return this.session ? this.accessFor(this.session.destination).user_id : null;
  }

  async sessionContact() {
    const destination = this.session?.destination ?? null;
    return {
      phone: destination?.startsWith('+') ? destination : null,
      email: destination?.includes('@') ? destination : null,
    };
  }

  /** Test hook: hold the next access lookup until the returned function is called. */
  holdNextFetch(): () => void {
    let release: () => void = () => undefined;
    this.pendingFetch = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  pendingFetch: Promise<void> | null = null;

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async requestPhoneCode(phone: string): Promise<AuthResult> {
    if (this.smsDown) return { ok: false, error: 'SMS_UNAVAILABLE', retryAfter: null };
    return this.request(phone, FAKE_SMS_CODE);
  }

  async verifyPhoneCode(phone: string, code: string) {
    return this.verify(phone, code);
  }

  async requestEmailCode(email: string) {
    return this.request(email, FAKE_EMAIL_CODE);
  }

  async verifyEmailCode(email: string, code: string) {
    return this.verify(email, code);
  }

  async assurance(): Promise<Assurance> {
    if (!this.session) return { current: null, next: null };
    return { current: this.aal, next: this.factors.length > 0 ? 'aal2' : this.aal };
  }

  async verifiedTotpFactorIds() {
    return [...this.factors];
  }

  async enrollTotp(): Promise<TotpEnrollment | { error: AuthErrorKind }> {
    return {
      factorId: 'factor-1',
      uri: 'otpauth://totp/SiteMuster:staff?secret=JBSWY3DPEHPK3PXP&issuer=SiteMuster',
      secret: 'JBSWY3DPEHPK3PXP',
    };
  }

  async verifyTotp(factorId: string, code: string): Promise<AuthResult> {
    if (code !== FAKE_TOTP_CODE) return { ok: false, error: 'MFA_INVALID_CODE', retryAfter: null };
    if (!this.factors.includes(factorId)) this.factors.push(factorId);
    this.aal = 'aal2';
    this.emit();
    return { ok: true };
  }

  async fetchAccess(): Promise<Access> {
    // Like a real request, the answer reflects the session at the time the request was sent.
    const destination = this.session?.destination;
    const aal = this.aal;
    if (this.pendingFetch) {
      const wait = this.pendingFetch;
      this.pendingFetch = null;
      await wait;
    }
    if (this.offline) throw new Error('network unavailable');
    if (!destination) throw new Error('no session');
    return { ...this.accessFor(destination), aal };
  }

  async saveLanguage(locale: Locale) {
    this.savedLanguages.push(locale);
  }

  async signOut() {
    this.session = null;
    this.aal = 'aal1';
    this.emit();
  }
}

export function fakeBackend(
  accessFor: (destination: string) => Access,
  api: SiteMusterApi | null = null,
) {
  const storage = new EncryptedSessionStorage(
    memoryTable(),
    memoryKeys(),
    (n) => new Uint8Array(randomBytes(n)),
  );
  return { gateway: new FakeAuthGateway(accessFor), storage, api };
}

export const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  worker: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  org: '44444444-4444-4444-8444-444444444444',
};

export function access(overrides: Partial<Access>): Access {
  return {
    user_id: ids.user,
    aal: 'aal1',
    email_verified: false,
    phone_verified: true,
    is_platform_operator: false,
    account_deletion_pending: false,
    worker_profile_id: null,
    is_foreman: false,
    org_roles: [],
    project_roles: [],
    ...overrides,
  };
}
