import { redact } from '../../../packages/shared/src/privacy/redact.ts';

/**
 * The only way Edge Functions write logs (docs/spec/09-security-privacy.md: no GPS data, contacts,
 * codes or credentials in HTTP error logs). Entries are already built from request ids, outcome
 * codes, counts and truncated ids; the scrubber runs again so a future field cannot leak.
 */
export function logSafe(entry: Record<string, unknown>): void {
  console.warn(JSON.stringify(redact(entry)));
}
