import { isCoordinateKey } from './coordinates.ts';

/**
 * Privacy scrubber for crash reports, logs and diagnostics (docs/spec/09-security-privacy.md).
 * Removes coordinates, contact data, OTPs, bearer/device tokens, badge payloads, emergency
 * contacts and names. Used by the Sentry `beforeSend` hook and by Edge Function loggers.
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /phone/i,
  /e-?mail/i,
  /otp/i,
  /passcode/i,
  /password/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /api[_-]?key/i,
  /^key$/i,
  /emergency/i,
  /contact/i,
  /legal_name|full_name|first_name|last_name|display_name|^name$/i,
  /badge_payload|^badge$|printed_badge/i,
  /^mac$|hmac/i,
  /address/i,
  /ip_address|^ip$/i,
  /credential/i,
  /session_json|refresh/i,
];

const STRING_PATTERNS: readonly [RegExp, string][] = [
  // JSON Web Tokens
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],
  // Bearer credentials
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  // Offline badge payloads (replayable within the step window)
  [/SMB1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.\d{8,12}\.[A-Za-z0-9_-]{22}/g, '[REDACTED_BADGE]'],
  [/SMP1\.[A-Za-z0-9_-]{22,64}/g, '[REDACTED_BADGE]'],
  // Email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
  // Latitude/longitude pairs such as "29.7604,-95.3698" or "29.7604 -95.3698"
  [/-?\d{1,3}\.\d{3,}\s*[, ]\s*-?\d{1,3}\.\d{3,}/g, '[REDACTED_COORDS]'],
  // Keyed coordinates in serialized text: "latitude":29.76, lat=29.76, 'lng': -95.36 (any quoting)
  [
    /(["']?)\b(lat|lng|lon|long|latitude|longitude)\1(\s*[:=]\s*)["']?-?\d{1,3}(?:\.\d+)?["']?/gi,
    '$1$2$1$3[REDACTED_COORD]',
  ],
  // E.164 and common North American phone formats
  [/\+\d{8,15}/g, '[REDACTED_PHONE]'],
  [/\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, '[REDACTED_PHONE]'],
  // Long base64url/hex secrets (device tokens are 43 base64url chars)
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED_SECRET]'],
  // Six-digit codes adjacent to OTP/code wording
  [/\b(otp|code|c[oó]digo)\b(\s*[:=]?\s*)\d{4,8}\b/gi, '$1$2[REDACTED_OTP]'],
];

export function isSensitiveKey(key: string): boolean {
  if (isCoordinateKey(key)) return true;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function redactString(value: string, depth = 0): string {
  // Serialized JSON (e.g. a crash message built with JSON.stringify) is parsed and redacted by
  // key, exactly like an object, so nested coordinates or contacts never pass through as text.
  const trimmed = value.trim();
  if (depth < 4 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      return JSON.stringify(redact(JSON.parse(trimmed) as unknown, depth + 1));
    } catch {
      // Not JSON: fall through to the text patterns.
    }
  }
  let out = value;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Deep-redacts any JSON-like value. Returns a new value; never mutates its input. */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value, depth);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(child, depth + 1, seen);
  }
  return out;
}

/** Minimal structural view of a crash-report event (compatible with Sentry's Event type). */
export interface ScrubbableEvent {
  message?: string;
  user?: { id?: string | number; [key: string]: unknown };
  request?: { [key: string]: unknown };
  extra?: { [key: string]: unknown };
  contexts?: { [key: string]: unknown };
  tags?: { [key: string]: unknown };
  breadcrumbs?: ScrubbableBreadcrumb[];
  exception?: { values?: { value?: string; [key: string]: unknown }[] };
  [key: string]: unknown;
}

export interface ScrubbableBreadcrumb {
  message?: string;
  data?: { [key: string]: unknown };
  [key: string]: unknown;
}

export function scrubBreadcrumb<T extends object>(input: T): T {
  const breadcrumb = input as unknown as ScrubbableBreadcrumb;
  const scrubbed: ScrubbableBreadcrumb = {
    ...breadcrumb,
    ...(breadcrumb.message !== undefined ? { message: redactString(breadcrumb.message) } : {}),
    ...(breadcrumb.data !== undefined
      ? { data: redact(breadcrumb.data) as ScrubbableBreadcrumb['data'] }
      : {}),
  };
  return scrubbed as unknown as T;
}

/**
 * Scrub a crash-report event. Keeps only the pseudonymous user id (no email/ip/username),
 * drops request bodies, cookies and headers, and redacts every free-text field.
 */
export function scrubEvent<T extends object>(input: T): T {
  const event = input as unknown as ScrubbableEvent;
  const scrubbed: ScrubbableEvent = { ...event };
  if (event.message !== undefined) scrubbed.message = redactString(event.message);
  if (event.user !== undefined) {
    scrubbed.user = event.user.id !== undefined ? { id: event.user.id } : {};
  }
  if (event.request !== undefined) {
    const { url, method } = event.request as { url?: unknown; method?: unknown };
    scrubbed.request = {
      ...(typeof url === 'string' ? { url: redactString(url.split('?')[0] ?? '') } : {}),
      ...(typeof method === 'string' ? { method } : {}),
    };
  }
  if (event.extra !== undefined) scrubbed.extra = redact(event.extra) as ScrubbableEvent['extra'];
  if (event.contexts !== undefined) {
    scrubbed.contexts = redact(event.contexts) as ScrubbableEvent['contexts'];
  }
  if (event.tags !== undefined) scrubbed.tags = redact(event.tags) as ScrubbableEvent['tags'];
  if (event.breadcrumbs !== undefined) {
    scrubbed.breadcrumbs = event.breadcrumbs.map((crumb) => scrubBreadcrumb(crumb));
  }
  if (event.exception?.values !== undefined) {
    scrubbed.exception = {
      ...event.exception,
      values: event.exception.values.map((entry) => ({
        ...entry,
        ...(entry.value !== undefined ? { value: redactString(entry.value) } : {}),
      })),
    };
  }
  return scrubbed as unknown as T;
}
