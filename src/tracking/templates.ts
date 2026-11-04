/**
 * Native SDK record templates (docs/spec/11 "Native SDK config"; decisions #45, #90, #91).
 *
 * - The GEOFENCE template is coordinate-free by construction: uuid, timestamp, event, fence
 *   identifier, ENTER/EXIT and horizontal accuracy (EXIT corroboration) — never latitude/longitude.
 *   It is the only record shape the phone can produce while armed offsite.
 * - The LOCATION template sends only what attendance needs (no speed, heading, altitude, battery,
 *   activity or odometer). Location records exist only while the device is inside one of its
 *   bound native fences in released (privacy-signed-off) onsite mode, and the egress gate removes
 *   any that is not before upload.
 *
 * The exact rendered wire must be captured from a development build on real iOS and Android
 * devices before release (HUMAN_CHECKLIST §9); the server accepts this shape only.
 */
export const GEOFENCE_TEMPLATE =
  '{"uuid":"<%= uuid %>","timestamp":"<%= timestamp %>","event":"geofence",' +
  '"geofence":{"identifier":"<%= geofence.identifier %>","action":"<%= geofence.action %>"},' +
  '"accuracy":<%= accuracy %>}';

export const LOCATION_TEMPLATE =
  '{"uuid":"<%= uuid %>","timestamp":"<%= timestamp %>","event":"<%= event %>",' +
  '"coords":{"latitude":<%= latitude %>,"longitude":<%= longitude %>,"accuracy":<%= accuracy %>},' +
  // Booleans are quoted: a tag a platform leaves empty must still render valid JSON.
  '"is_moving":"<%= is_moving %>","mock":"<%= mock %>"}';

const TAG = /<%=\s*([a-z_.]+)\s*%>/g;

/** The tags a template reads (used to prove the geofence template never reads a coordinate). */
export function templateTags(template: string): string[] {
  return [...template.matchAll(TAG)].map((match) => match[1] as string);
}

/**
 * Renders a template the way the native SDK does (simple tag substitution, values inserted as
 * JSON-safe strings). Used by the simulated SDK so tests capture the same wire as a device.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | number | boolean | null | undefined>>,
): string {
  return template.replace(TAG, (_match, tag: string) => {
    const value = values[tag];
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value.replace(/["\\]/g, '') : String(value);
  });
}
