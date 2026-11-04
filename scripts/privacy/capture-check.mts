import { containsCoordinateKeys } from '../../packages/shared/src/privacy/coordinates.ts';

/**
 * Checks a real-device network capture (HAR file) against the location privacy rules before the
 * release sign-off (docs/spec/03 "Privacy assertions", docs/spec/10 "physical privacy capture",
 * HUMAN_CHECKLIST §10; decision #152). It helps the person doing the walk; it does not replace
 * reading the capture.
 *
 * Rules:
 * - geofence records never carry a position;
 * - every position lies inside the site circle plus the exit margin;
 * - no position was recorded after leaving (after an EXIT, before the next ENTER);
 * - no other request (crash reports, push, renewals, any other host) carries coordinates.
 *
 * The report never prints a coordinate, a token or a header: only counts, distances in metres,
 * host names and record times.
 */
export interface Site {
  lat: number;
  lng: number;
  radiusM: number;
  /** Exit hysteresis allowance (the native fence is site radius + 50 m by default). */
  marginM: number;
}

export interface Finding {
  level: 'FAIL' | 'WARN';
  code:
    | 'NO_UPLOADS'
    | 'UNPARSABLE_UPLOAD'
    | 'GEOFENCE_WITH_COORDINATES'
    | 'POSITION_OUTSIDE_SITE'
    | 'POSITION_AFTER_EXIT'
    | 'POSITION_BEFORE_ENTER'
    | 'COORDINATES_IN_OTHER_REQUEST'
    | 'UNREADABLE_BODY';
  message: string;
}

export interface CaptureReport {
  verdict: 'PASS' | 'FAIL';
  uploads: number;
  renewals: number;
  records: { geofence: number; positions: number; other: number };
  enters: number;
  exits: number;
  maxDistanceM: number | null;
  hosts: { host: string; requests: number }[];
  findings: Finding[];
}

interface HarEntry {
  startedDateTime?: string;
  request?: {
    method?: string;
    url?: string;
    postData?: { text?: string; mimeType?: string };
  };
}

interface SdkRecord {
  timestamp?: unknown;
  event?: unknown;
  geofence?: { action?: unknown };
  coords?: { latitude?: unknown; longitude?: unknown };
}

const INGEST_PATH = '/functions/v1/ingest-location-batch';
const RENEW_PATH = '/functions/v1/device-renew';
const EARTH_RADIUS_M = 6_371_008.8;

export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function parseSite(value: string, marginM = 50): Site {
  const parts = value.split(',').map((part) => Number(part.trim()));
  const [lat, lng, radiusM] = parts;
  if (
    parts.length !== 3 ||
    lat === undefined ||
    lng === undefined ||
    radiusM === undefined ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(radiusM) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    radiusM < 1 ||
    !Number.isFinite(marginM) ||
    marginM < 0
  ) {
    throw new Error('--site must be "<latitude>,<longitude>,<radius metres>"');
  }
  return { lat, lng, radiusM, marginM };
}

function entriesOf(har: unknown): HarEntry[] {
  const entries = (har as { log?: { entries?: unknown } } | null)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Not a HAR file: log.entries is missing.');
  return entries as HarEntry[];
}

function urlOf(entry: HarEntry): URL | null {
  try {
    return new URL(entry.request?.url ?? '');
  } catch {
    return null;
  }
}

function jsonBody(entry: HarEntry): { ok: true; value: unknown } | { ok: false } {
  const text = entry.request?.postData?.text;
  if (typeof text !== 'string' || text.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function positionOf(record: SdkRecord): { lat: number; lng: number } | null {
  const lat = Number(record.coords?.latitude);
  const lng = Number(record.coords?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function timeOf(record: SdkRecord, fallback: string | undefined): number {
  const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return Number.isNaN(stamp) ? Date.parse(fallback ?? '') : stamp;
}

export function checkCapture(har: unknown, site: Site): CaptureReport {
  const findings: Finding[] = [];
  const hosts = new Map<string, number>();
  const records: { record: SdkRecord; at: number }[] = [];
  let uploads = 0;
  let renewals = 0;

  for (const entry of entriesOf(har)) {
    const url = urlOf(entry);
    if (!url) continue;
    hosts.set(url.host, (hosts.get(url.host) ?? 0) + 1);
    const isUpload = url.pathname.endsWith(INGEST_PATH) && entry.request?.method === 'POST';
    if (isUpload) {
      uploads += 1;
      const body = jsonBody(entry);
      const locations = body.ok ? (body.value as { locations?: unknown }).locations : undefined;
      if (!Array.isArray(locations)) {
        findings.push({
          level: 'FAIL',
          code: 'UNPARSABLE_UPLOAD',
          message: `An upload at ${entry.startedDateTime ?? 'an unknown time'} has no readable "locations" list; inspect it by hand.`,
        });
        continue;
      }
      for (const record of locations as SdkRecord[]) {
        records.push({ record, at: timeOf(record, entry.startedDateTime) });
      }
      continue;
    }
    if (url.pathname.endsWith(RENEW_PATH)) renewals += 1;
    // Every other request: no coordinates in its JSON body or its query string.
    const query = Object.fromEntries(url.searchParams.entries());
    const body = jsonBody(entry);
    const text = entry.request?.postData?.text;
    if (containsCoordinateKeys(query) || (body.ok && containsCoordinateKeys(body.value))) {
      findings.push({
        level: 'FAIL',
        code: 'COORDINATES_IN_OTHER_REQUEST',
        message: `A request to ${url.host}${url.pathname} carries coordinate fields.`,
      });
    } else if (
      !body.ok &&
      typeof text === 'string' &&
      /latitude|longitude|"lat"|"lng"|coords/i.test(text)
    ) {
      findings.push({
        level: 'WARN',
        code: 'UNREADABLE_BODY',
        message: `A non-JSON request to ${url.host}${url.pathname} mentions coordinates; inspect it by hand.`,
      });
    }
  }

  if (uploads === 0) {
    findings.push({
      level: 'FAIL',
      code: 'NO_UPLOADS',
      message: `No request to ${INGEST_PATH} was captured: the capture proves nothing.`,
    });
  }

  records.sort((a, b) => a.at - b.at);
  let state: 'unknown' | 'inside' | 'left' = 'unknown';
  let enters = 0;
  let exits = 0;
  let geofence = 0;
  let positions = 0;
  let other = 0;
  let outside = 0;
  let afterExit = 0;
  let beforeEnter = 0;
  let maxDistance: number | null = null;
  for (const { record } of records) {
    if (record.event === 'geofence') {
      geofence += 1;
      if (containsCoordinateKeys(record)) {
        findings.push({
          level: 'FAIL',
          code: 'GEOFENCE_WITH_COORDINATES',
          message: 'A geofence record carries a position (it must be coordinate-free).',
        });
      }
      if (record.geofence?.action === 'ENTER') {
        enters += 1;
        state = 'inside';
      } else if (record.geofence?.action === 'EXIT') {
        exits += 1;
        state = 'left';
      }
      continue;
    }
    const position = positionOf(record);
    if (!position) {
      other += 1;
      continue;
    }
    positions += 1;
    const distance = distanceM(site, position);
    maxDistance = Math.max(maxDistance ?? 0, distance);
    if (distance > site.radiusM + site.marginM) outside += 1;
    if (state === 'left') afterExit += 1;
    if (state === 'unknown') beforeEnter += 1;
  }
  if (outside > 0) {
    findings.push({
      level: 'FAIL',
      code: 'POSITION_OUTSIDE_SITE',
      message: `${outside} position(s) lie outside the site circle plus ${site.marginM} m (farthest ${Math.round(maxDistance ?? 0)} m from the centre).`,
    });
  }
  if (afterExit > 0) {
    findings.push({
      level: 'FAIL',
      code: 'POSITION_AFTER_EXIT',
      message: `${afterExit} position(s) were recorded after leaving the site (after an EXIT, before the next ENTER).`,
    });
  }
  if (beforeEnter > 0) {
    findings.push({
      level: 'WARN',
      code: 'POSITION_BEFORE_ENTER',
      message: `${beforeEnter} position(s) come before the first ENTER in the capture; check they are the already-inside check on site.`,
    });
  }

  return {
    verdict: findings.some((finding) => finding.level === 'FAIL') ? 'FAIL' : 'PASS',
    uploads,
    renewals,
    records: { geofence, positions, other },
    enters,
    exits,
    maxDistanceM: maxDistance === null ? null : Math.round(maxDistance),
    hosts: [...hosts]
      .map(([host, requests]) => ({ host, requests }))
      .sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host)),
    findings,
  };
}

export function formatReport(report: CaptureReport, site: Site): string {
  const lines = [
    `Location privacy capture check: ${report.verdict}`,
    '',
    `Site: radius ${site.radiusM} m + ${site.marginM} m margin (centre not printed).`,
    `Uploads to ingest-location-batch: ${report.uploads}; device-renew calls: ${report.renewals}.`,
    `Records: ${report.records.geofence} geofence (${report.enters} ENTER, ${report.exits} EXIT), ${report.records.positions} with a position, ${report.records.other} other.`,
    `Farthest position from the centre: ${report.maxDistanceM === null ? 'none sent' : `${report.maxDistanceM} m`}.`,
    '',
    'Hosts contacted:',
    ...report.hosts.map((row) => `  ${row.host}: ${row.requests}`),
    '',
    report.findings.length === 0 ? 'No findings.' : 'Findings:',
    ...report.findings.map((finding) => `  ${finding.level} ${finding.code}: ${finding.message}`),
  ];
  return lines.join('\n');
}
