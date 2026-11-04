/**
 * Phone normalization for SMS sign-in. Accepts US/Canada numbers typed naturally
 * ("(555) 555-0123", "555.555.0123", "1 555 555 0123") or full E.164 ("+525512345678").
 * Never invents a number: anything ambiguous is rejected.
 */
export type PhoneResult = { ok: true; e164: string } | { ok: false };

export function normalizePhone(input: string): PhoneResult {
  const trimmed = input.trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/[\s().-]/g, '');
    return /^[1-9]\d{7,14}$/.test(digits) ? { ok: true, e164: `+${digits}` } : { ok: false };
  }
  if (/[^\d\s().-]/.test(trimmed)) return { ok: false };
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10 && /^[2-9]/.test(digits)) return { ok: true, e164: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits.slice(1))) {
    return { ok: true, e164: `+${digits}` };
  }
  return { ok: false };
}

/** Display form that hides the middle digits, e.g. "+1 ••• ••• 0123". */
export function maskPhone(e164: string): string {
  const last4 = e164.slice(-4);
  return `${e164.slice(0, e164.startsWith('+1') ? 2 : 3)} ••• ••• ${last4}`;
}

export function isValidEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.trim());
}

/** Masks an email for display, e.g. "na•••@company.com". */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.trim().split('@');
  return `${local.slice(0, 2)}•••@${domain}`;
}
