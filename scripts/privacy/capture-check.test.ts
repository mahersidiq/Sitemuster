import { describe, expect, it } from 'vitest';

import { GEOFENCE_TEMPLATE, LOCATION_TEMPLATE, renderTemplate } from '../../src/tracking/templates';
import { checkCapture, distanceM, formatReport, parseSite } from './capture-check.mts';

/**
 * The capture checker on synthetic captures shaped exactly like the phone's wire (the production
 * templates). Each rule has a negative control: a capture that breaks it must FAIL.
 */
const SITE = parseSite('30.2672,-97.7431,150');
const HOST = 'https://abcdefghijklmnop.supabase.co';
const TOKEN = 'Bearer device-secret-never-printed';

const geofence = (action: 'ENTER' | 'EXIT', timestamp: string) =>
  JSON.parse(
    renderTemplate(GEOFENCE_TEMPLATE, {
      uuid: crypto.randomUUID(),
      timestamp,
      'geofence.identifier': 'sm_demo',
      'geofence.action': action,
      accuracy: 12,
    }),
  ) as Record<string, unknown>;
const fix = (timestamp: string, latitude = 30.2673, longitude = -97.743) =>
  JSON.parse(
    renderTemplate(LOCATION_TEMPLATE, {
      uuid: crypto.randomUUID(),
      timestamp,
      event: 'location',
      latitude,
      longitude,
      accuracy: 10,
      is_moving: false,
      mock: false,
    }),
  ) as Record<string, unknown>;

function upload(records: Record<string, unknown>[], at: string) {
  return {
    startedDateTime: at,
    request: {
      method: 'POST',
      url: `${HOST}/functions/v1/ingest-location-batch`,
      headers: [{ name: 'Authorization', value: TOKEN }],
      postData: { mimeType: 'application/json', text: JSON.stringify({ locations: records }) },
    },
  };
}
const request = (url: string, body?: unknown) => ({
  startedDateTime: '2026-11-04T16:00:00Z',
  request: {
    method: body === undefined ? 'GET' : 'POST',
    url,
    postData: body === undefined ? undefined : { text: JSON.stringify(body) },
  },
});
const har = (...entries: unknown[]) => ({ log: { version: '1.2', entries } });

/** A clean day: arrive, two fixes on site, leave; the phone renews its secret and pings Sentry. */
function cleanDay() {
  return [
    upload(
      [geofence('ENTER', '2026-11-04T13:00:00Z'), fix('2026-11-04T13:00:05Z')],
      '2026-11-04T13:00:06Z',
    ),
    upload([fix('2026-11-04T13:11:00Z'), fix('2026-11-04T15:00:00Z')], '2026-11-04T15:00:01Z'),
    upload([geofence('EXIT', '2026-11-04T17:00:00Z')], '2026-11-04T17:05:00Z'),
    request(`${HOST}/functions/v1/device-renew`, { app_version: '1.0.0' }),
    request('https://o0.ingest.sentry.io/api/1/envelope/', { exception: { type: 'Error' } }),
  ];
}

describe('privacy capture check', () => {
  it('passes a clean walk and prints no coordinate or token', () => {
    const report = checkCapture(har(...cleanDay()), SITE);
    expect(report.verdict).toBe('PASS');
    expect(report.uploads).toBe(3);
    expect(report.renewals).toBe(1);
    expect(report.records).toEqual({ geofence: 2, positions: 3, other: 0 });
    expect(report.enters).toBe(1);
    expect(report.exits).toBe(1);
    const text = formatReport(report, SITE);
    expect(text).toContain('Location privacy capture check: PASS');
    expect(text).not.toMatch(/30\.26|97\.74/);
    expect(text).not.toContain('device-secret');
    expect(text).toContain('o0.ingest.sentry.io: 1');
  });

  it('fails a capture with no uploads (proves nothing)', () => {
    expect(
      checkCapture(har(request(`${HOST}/rest/v1/rpc/get_my_access`, {})), SITE).findings,
    ).toEqual([expect.objectContaining({ level: 'FAIL', code: 'NO_UPLOADS' })]);
  });

  it('fails a geofence record that carries a position', () => {
    const leaky = {
      ...geofence('EXIT', '2026-11-04T17:00:00Z'),
      coords: { latitude: 30.4, longitude: -97.9 },
    };
    const report = checkCapture(har(...cleanDay(), upload([leaky], '2026-11-04T17:06:00Z')), SITE);
    expect(report.verdict).toBe('FAIL');
    expect(report.findings.map((finding) => finding.code)).toContain('GEOFENCE_WITH_COORDINATES');
  });

  it('fails a position outside the site circle plus the margin, reporting only the distance', () => {
    const far = fix('2026-11-04T14:00:00Z', 30.2672 + 0.0025, -97.7431); // about 278 m north
    const report = checkCapture(har(...cleanDay(), upload([far], '2026-11-04T14:00:01Z')), SITE);
    expect(report.verdict).toBe('FAIL');
    const finding = report.findings.find((entry) => entry.code === 'POSITION_OUTSIDE_SITE');
    expect(finding?.message).toMatch(/1 position\(s\).*farthest 27\d m/);
    expect(formatReport(report, SITE)).not.toMatch(/30\.26|97\.74/);
  });

  it('fails a position recorded after leaving, even when it is inside the circle and sent late', () => {
    const late = fix('2026-11-04T17:20:00Z');
    const report = checkCapture(har(...cleanDay(), upload([late], '2026-11-04T18:00:00Z')), SITE);
    expect(report.verdict).toBe('FAIL');
    expect(report.findings.map((finding) => finding.code)).toContain('POSITION_AFTER_EXIT');
  });

  it('accepts positions recorded on site before the exit even if they were sent after it', () => {
    const queued = fix('2026-11-04T16:59:00Z');
    expect(
      checkCapture(har(...cleanDay(), upload([queued], '2026-11-04T17:30:00Z')), SITE).verdict,
    ).toBe('PASS');
  });

  it('allows a second visit: positions after a new ENTER are fine', () => {
    const report = checkCapture(
      har(
        ...cleanDay(),
        upload(
          [geofence('ENTER', '2026-11-04T18:00:00Z'), fix('2026-11-04T18:00:05Z')],
          '2026-11-04T18:00:06Z',
        ),
      ),
      SITE,
    );
    expect(report.verdict).toBe('PASS');
    expect(report.enters).toBe(2);
  });

  it('fails coordinates in any other request: crash reports, renewals, other hosts or query strings', () => {
    for (const leak of [
      request('https://o0.ingest.sentry.io/api/1/envelope/', { extra: { lat: 30.3, lng: -97.8 } }),
      request(`${HOST}/functions/v1/device-renew`, {
        app_version: '1',
        coords: { latitude: 30.3 },
      }),
      request('https://analytics.example.test/collect?latitude=30.3&longitude=-97.8'),
    ]) {
      const report = checkCapture(har(...cleanDay(), leak), SITE);
      expect(report.verdict).toBe('FAIL');
      expect(report.findings.map((finding) => finding.code)).toContain(
        'COORDINATES_IN_OTHER_REQUEST',
      );
    }
  });

  it('fails coordinates in form fields and header names of other requests (decision #154)', () => {
    const at = '2026-11-04T16:00:00Z';
    for (const leak of [
      {
        startedDateTime: at,
        request: {
          method: 'POST',
          url: 'https://analytics.example.test/collect',
          postData: { mimeType: 'application/x-www-form-urlencoded', text: 'lat=30.3&lng=-97.8' },
        },
      },
      {
        startedDateTime: at,
        request: {
          method: 'POST',
          url: 'https://analytics.example.test/upload',
          postData: {
            mimeType: 'multipart/form-data',
            params: [{ name: 'longitude', value: '-97' }],
          },
        },
      },
      {
        startedDateTime: at,
        request: {
          method: 'GET',
          url: 'https://analytics.example.test/ping',
          headers: [{ name: 'Geo', value: '30.3;-97.8' }],
        },
      },
    ]) {
      const report = checkCapture(har(...cleanDay(), leak), SITE);
      expect(report.verdict).toBe('FAIL');
      expect(report.findings.map((finding) => finding.code)).toContain(
        'COORDINATES_IN_OTHER_REQUEST',
      );
    }
  });

  it('fails coordinates anywhere in an upload outside its records: query, other body fields, header names (decision #154)', () => {
    const offsite = { latitude: 30.31, longitude: -97.81 };
    const changed = (change: (entry: ReturnType<typeof upload>) => void) => {
      const entry = upload([], '2026-11-04T14:00:00Z');
      change(entry);
      return entry;
    };
    for (const leak of [
      // The review's reproduction: no records at all, offsite coordinates in the body and the query.
      changed((entry) => {
        entry.request.url += '?lat=30.31&lng=-97.81';
        entry.request.postData.text = JSON.stringify({ locations: [], coords: offsite });
      }),
      changed((entry) => {
        entry.request.url += '?latitude=30.31';
      }),
      changed((entry) => {
        entry.request.postData.text = JSON.stringify({
          locations: [],
          extras: { position: offsite },
        });
      }),
      changed((entry) => {
        entry.request.headers.push({ name: 'Latitude', value: '30.31' });
      }),
    ]) {
      const report = checkCapture(har(...cleanDay(), leak), SITE);
      expect(report.verdict).toBe('FAIL');
      expect(report.findings.map((finding) => finding.code)).toContain(
        'COORDINATES_IN_UPLOAD_ENVELOPE',
      );
      expect(formatReport(report, SITE)).not.toMatch(/30\.31|97\.81/);
    }
  });

  it('fails record coordinates the site check cannot place instead of counting them as "other" (decision #154)', () => {
    const onsite = fix('2026-11-04T14:00:00Z');
    for (const record of [
      { ...onsite, coords: { lat: 30.31, lng: -97.81 } },
      { ...onsite, extras: { location: { latitude: 30.31, longitude: -97.81 } } },
      { ...onsite, coords: { latitude: 30.31 } },
      { ...onsite, coords: '30.31,-97.81' },
      { uuid: crypto.randomUUID(), timestamp: '2026-11-04T14:00:00Z', position: '30.31,-97.81' },
    ]) {
      const report = checkCapture(
        har(...cleanDay(), upload([record], '2026-11-04T14:00:01Z')),
        SITE,
      );
      expect(report.verdict).toBe('FAIL');
      expect(report.findings.map((finding) => finding.code)).toContain(
        'UNCHECKED_RECORD_COORDINATES',
      );
    }
  });

  it('fails an upload it cannot read instead of passing it unread', () => {
    const broken = { ...upload([], '2026-11-04T14:00:00Z') };
    broken.request.postData = { mimeType: 'application/json', text: 'not json' };
    expect(checkCapture(har(...cleanDay(), broken), SITE).findings.map((f) => f.code)).toContain(
      'UNPARSABLE_UPLOAD',
    );
  });

  it('warns about positions before the first ENTER (to be checked by hand)', () => {
    const early = fix('2026-11-04T12:00:00Z');
    const report = checkCapture(har(upload([early], '2026-11-04T12:00:01Z'), ...cleanDay()), SITE);
    expect(report.verdict).toBe('PASS');
    expect(report.findings).toEqual([
      expect.objectContaining({ level: 'WARN', code: 'POSITION_BEFORE_ENTER' }),
    ]);
  });

  it('validates its inputs', () => {
    expect(() => parseSite('30.2,-97.7')).toThrow(/--site/);
    expect(() => parseSite('95,-97.7,150')).toThrow(/--site/);
    expect(() => checkCapture({ nope: true }, SITE)).toThrow(/HAR/);
    expect(Math.round(distanceM({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }))).toBe(111_195);
  });
});
