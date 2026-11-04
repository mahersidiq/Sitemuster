import type { Locale } from '../locale.ts';

/**
 * Provider interfaces (docs/setup/HUMAN_CHECKLIST.md "No-account development rules").
 * Each has a real implementation (added in its milestone) and a typed Fake* implementation that
 * may only be constructed in `development` or automated `test` environments.
 */

export type ProviderKind = 'real' | 'fake';

export interface ProviderBase {
  readonly name: string;
  readonly kind: ProviderKind;
}

/** Worker phone OTP delivery (real: Supabase Phone Auth configured with Twilio). */
export interface SmsOtpProvider extends ProviderBase {
  requestOtp(phoneE164: string, locale: Locale): Promise<{ status: 'sent' | 'rate_limited' }>;
  verifyOtp(
    phoneE164: string,
    code: string,
  ): Promise<{ status: 'verified' | 'invalid' | 'expired' }>;
}

export interface AddressCandidate {
  placeId: string;
  primaryText: string;
  secondaryText: string;
}

export interface ResolvedAddress {
  placeId: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  attribution: string;
}

/** Address autocomplete + geocoding (real: Google Places (New) + Geocoding via Edge Function). */
export interface AddressProvider extends ProviderBase {
  search(query: string, sessionToken: string, locale: Locale): Promise<AddressCandidate[]>;
  resolve(placeId: string, sessionToken: string): Promise<ResolvedAddress>;
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string | number | boolean>;
  silent?: boolean;
  /** Interactive actions registered on the phone (e.g. the muster I'M SAFE button). */
  categoryId?: string;
  /** Android notification channel (created by the app). */
  channelId?: string;
  priority?: 'default' | 'high';
  sound?: 'default' | null;
}

export interface PushTicket {
  to: string;
  status: 'ok' | 'error';
  error?: string;
}

/** Push delivery (real: Expo Push Service). Delivery status is metadata, never presence proof. */
export interface PushProvider extends ProviderBase {
  send(messages: PushMessage[]): Promise<PushTicket[]>;
}

export interface CircularRegion {
  identifier: string;
  latitude: number;
  longitude: number;
  radiusM: number;
}

export type LocationProviderEvent =
  | {
      type: 'GEOFENCE';
      uuid: string;
      timestamp: string;
      identifier: string;
      action: 'ENTER' | 'EXIT';
      accuracy: number;
    }
  | {
      type: 'ONSITE_FIX';
      uuid: string;
      timestamp: string;
      latitude: number;
      longitude: number;
      accuracy: number;
    };

/** Device location engine (real: Transistorsoft v5 native SDK; fake: deterministic trace driver). */
export interface LocationProvider extends ProviderBase {
  armGeofences(regions: CircularRegion[]): Promise<void>;
  disarm(): Promise<void>;
  onEvent(listener: (event: LocationProviderEvent) => void): () => void;
}

export interface IssuedDeviceCredential {
  /** Plaintext upload token: returned exactly once to the device, never stored server-side. */
  token: string;
  tokenSha256Hex: string;
  /** Plaintext badge secret: returned exactly once, stored server-side only as ciphertext. */
  badgeSecret: string;
  badgeSecretCiphertext: string;
}

/** Server-side device credential issuance (real mode needs the server-only badge encryption key). */
export interface CredentialProvisioner extends ProviderBase {
  issue(): Promise<IssuedDeviceCredential>;
}
