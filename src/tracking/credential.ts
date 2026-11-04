import { DeviceRenewResponseSchema, ms, TRACKING_DEFAULTS } from '@sitemuster/shared';

/**
 * Device upload secret lifecycle on the phone (docs/spec/03; decision #44). Renewal paths, in
 * order: app foreground (≤ 7 days left), the SDK's own native refresh when `expires` is reached
 * (headless), and — with the push pipeline (Milestone 11) — silent pushes and visible reminders.
 * None is guaranteed; the roster shows CREDENTIAL_EXPIRING/EXPIRED so a foreman can ask the
 * worker to open the app.
 */
const DAY = 24 * 60 * 60 * 1000;
const RENEW_BEFORE = TRACKING_DEFAULTS.device_upload_renew_before_expiry_days * DAY;
const EXPIRING = TRACKING_DEFAULTS.credential_expiring_roster_flag_days * DAY;

export type CredentialState = 'OK' | 'EXPIRING' | 'EXPIRED' | 'NONE';

export function credentialState(expiresAt: string | null, now: number): CredentialState {
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return 'NONE';
  const left = ms(expiresAt) - now;
  if (left <= 0) return 'EXPIRED';
  return left <= EXPIRING ? 'EXPIRING' : 'OK';
}

/** Foreground renewal is due inside the last 7 days (and always after expiry). */
export function renewalDue(expiresAt: string | null, now: number): boolean {
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return true;
  return ms(expiresAt) - now <= RENEW_BEFORE;
}

/** Epoch second at which the SDK should refresh natively (expiry − 7 days). */
export function renewAfterEpochSeconds(expiresAt: string): number {
  return Math.floor((ms(expiresAt) - RENEW_BEFORE) / 1000);
}

export type RenewOutcome =
  { ok: true; token: string; expiresAt: string; renewAfter: string } | { ok: false; code: string };

/** Renews with the current device secret (works without a Supabase session). */
export async function renewWithSecret(
  renewUrl: string,
  token: string,
  appVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RenewOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(renewUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ app_version: appVersion }),
    });
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return { ok: false, code: typeof code === 'string' ? code : `HTTP_${response.status}` };
  }
  const parsed = DeviceRenewResponseSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'INVALID_RESPONSE' };
  return {
    ok: true,
    token: parsed.data.upload_token,
    expiresAt: parsed.data.upload_expires_at,
    renewAfter: parsed.data.renew_after,
  };
}
