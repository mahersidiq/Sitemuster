/** Key names that carry geographic coordinates in any payload we receive or emit. */
const COORDINATE_KEY_PATTERN =
  /^(coords?|coordinates?|lat|lng|lon|long|latitude|longitude|location|position|point|geo|geometry|geography|onsite_point)$/i;

export function isCoordinateKey(key: string): boolean {
  return COORDINATE_KEY_PATTERN.test(key);
}

/**
 * Deep check for any coordinate-bearing key. Used to prove geofence (offsite-capable) payloads
 * are coordinate-free before they are accepted, quarantined or logged.
 */
export function containsCoordinateKeys(value: unknown, depth = 0): boolean {
  if (depth > 10 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsCoordinateKeys(item, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isCoordinateKey(key)) return true;
    if (containsCoordinateKeys(child, depth + 1)) return true;
  }
  return false;
}

/** Remove every coordinate-bearing key (deep copy). Used before quarantining a rejected record. */
export function stripCoordinateKeys(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[TRUNCATED]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripCoordinateKeys(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isCoordinateKey(key)) continue;
    out[key] = stripCoordinateKeys(child, depth + 1);
  }
  return out;
}
