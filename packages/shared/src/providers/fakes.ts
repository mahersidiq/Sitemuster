import type { RuntimeEnvironment } from '../app-env.ts';
import { TRACKING_DEFAULTS } from '../config/tracking-defaults.ts';
import { base64UrlEncode, sha256Hex, type RandomBytes } from '../crypto/encoding.ts';
import type { Locale } from '../locale.ts';
import { assertFakeAllowed } from './registry.ts';
import type {
  AddressCandidate,
  AddressProvider,
  CircularRegion,
  CredentialProvisioner,
  IssuedDeviceCredential,
  LocationProvider,
  LocationProviderEvent,
  PushMessage,
  PushProvider,
  PushTicket,
  ResolvedAddress,
  SmsOtpProvider,
} from './types.ts';

/**
 * Typed development-only fakes. Every constructor calls assertFakeAllowed(), so a fake cannot even
 * be instantiated in staging or production. Fakes never claim real delivery or real GPS evidence.
 */

export type Clock = () => number;

interface PendingOtp {
  code: string;
  issuedAtMs: number;
}

/**
 * Fake SMS OTP. Codes are random (never hardcoded), 6 digits, expire after 600 s and respect the
 * 60 s resend cooldown, mirroring the production contract so UI states can be exercised.
 */
export class FakeSmsOtpProvider implements SmsOtpProvider {
  readonly name = 'FakeSmsOtpProvider';
  readonly kind = 'fake' as const;
  private readonly pending = new Map<string, PendingOtp>();

  constructor(
    env: RuntimeEnvironment,
    private readonly randomBytes: RandomBytes,
    private readonly now: Clock = Date.now,
  ) {
    assertFakeAllowed(env, this.name);
  }

  async requestOtp(
    phoneE164: string,
    _locale: Locale,
  ): Promise<{ status: 'sent' | 'rate_limited' }> {
    const existing = this.pending.get(phoneE164);
    const cooldownMs = TRACKING_DEFAULTS.sms_resend_cooldown_seconds * 1000;
    if (existing && this.now() - existing.issuedAtMs < cooldownMs)
      return { status: 'rate_limited' };
    const bytes = this.randomBytes(4);
    const value =
      (((bytes[0] ?? 0) << 24) |
        ((bytes[1] ?? 0) << 16) |
        ((bytes[2] ?? 0) << 8) |
        (bytes[3] ?? 0)) >>>
      0;
    const code = String(value % 10 ** TRACKING_DEFAULTS.sms_otp_digits).padStart(
      TRACKING_DEFAULTS.sms_otp_digits,
      '0',
    );
    this.pending.set(phoneE164, { code, issuedAtMs: this.now() });
    return { status: 'sent' };
  }

  async verifyOtp(
    phoneE164: string,
    code: string,
  ): Promise<{ status: 'verified' | 'invalid' | 'expired' }> {
    const pending = this.pending.get(phoneE164);
    if (!pending) return { status: 'invalid' };
    if (this.now() - pending.issuedAtMs > TRACKING_DEFAULTS.sms_otp_expiry_seconds * 1000) {
      this.pending.delete(phoneE164);
      return { status: 'expired' };
    }
    if (pending.code !== code) return { status: 'invalid' };
    this.pending.delete(phoneE164);
    return { status: 'verified' };
  }

  /** Development/test inspection hook standing in for the phone's SMS inbox. */
  peekCodeForDevelopment(phoneE164: string): string | null {
    return this.pending.get(phoneE164)?.code ?? null;
  }
}

/** Fake address search: clearly labelled synthetic candidates, never real Google results. */
export class FakeAddressProvider implements AddressProvider {
  readonly name = 'FakeAddressProvider';
  readonly kind = 'fake' as const;

  constructor(env: RuntimeEnvironment) {
    assertFakeAllowed(env, this.name);
  }

  async search(query: string, _sessionToken: string, _locale: Locale): Promise<AddressCandidate[]> {
    const trimmed = query.trim();
    if (trimmed.length < 3) return [];
    return [1, 2, 3].map((n) => ({
      placeId: `dev-place-${sha256Hex(`${trimmed}|${n}`).slice(0, 16)}`,
      primaryText: `${trimmed} ${n}`,
      secondaryText: 'Development address (not real)',
    }));
  }

  async resolve(placeId: string, _sessionToken: string): Promise<ResolvedAddress> {
    const digest = sha256Hex(placeId);
    // Deterministic synthetic point near Houston, TX, derived from the place id.
    const lat = 29.7604 + (parseInt(digest.slice(0, 4), 16) / 0xffff - 0.5) * 0.1;
    const lng = -95.3698 + (parseInt(digest.slice(4, 8), 16) / 0xffff - 0.5) * 0.1;
    return {
      placeId,
      formattedAddress: `Development address ${placeId.slice(-6)} (not real)`,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      attribution: 'Development fake (no provider)',
    };
  }
}

/** Fake push: records messages; can simulate an outage. Delivery is never presence evidence. */
export class FakePushProvider implements PushProvider {
  readonly name = 'FakePushProvider';
  readonly kind = 'fake' as const;
  readonly sent: PushMessage[] = [];
  outage = false;

  constructor(env: RuntimeEnvironment) {
    assertFakeAllowed(env, this.name);
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    if (this.outage)
      return messages.map((m) => ({ to: m.to, status: 'error', error: 'FAKE_OUTAGE' }));
    this.sent.push(...messages);
    return messages.map((m) => ({ to: m.to, status: 'ok' }));
  }
}

/** Fake location engine: a deterministic trace driver used by CI and the dev-only simulator. */
export class FakeLocationProvider implements LocationProvider {
  readonly name = 'FakeLocationProvider';
  readonly kind = 'fake' as const;
  private readonly listeners = new Set<(event: LocationProviderEvent) => void>();
  private regions: CircularRegion[] = [];

  constructor(env: RuntimeEnvironment) {
    assertFakeAllowed(env, this.name);
  }

  async armGeofences(regions: CircularRegion[]): Promise<void> {
    this.regions = [...regions];
  }

  async disarm(): Promise<void> {
    this.regions = [];
  }

  armedRegions(): readonly CircularRegion[] {
    return this.regions;
  }

  onEvent(listener: (event: LocationProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit a scripted event (replay/test only). Geofence events never carry coordinates. */
  emit(event: LocationProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * Fake credential provisioner. Generates real 32-byte random tokens (so hashing/flows are
 * realistic) but marks badge-secret "ciphertext" with a FAKE prefix that production never accepts.
 */
export class FakeCredentialProvisioner implements CredentialProvisioner {
  readonly name = 'FakeCredentialProvisioner';
  readonly kind = 'fake' as const;

  constructor(
    env: RuntimeEnvironment,
    private readonly randomBytes: RandomBytes,
  ) {
    assertFakeAllowed(env, this.name);
  }

  async issue(): Promise<IssuedDeviceCredential> {
    const tokenBytes = this.randomBytes(32);
    const badgeBytes = this.randomBytes(32);
    const token = base64UrlEncode(tokenBytes);
    const badgeSecret = base64UrlEncode(badgeBytes);
    return {
      token,
      tokenSha256Hex: sha256Hex(tokenBytes),
      badgeSecret,
      badgeSecretCiphertext: `FAKE_DEV_ONLY.${badgeSecret}`,
    };
  }
}
