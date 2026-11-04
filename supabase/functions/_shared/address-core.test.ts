import { describe, expect, it, vi } from 'vitest';

import {
  AddressResolveResponseSchema,
  AddressSearchResponseSchema,
} from '../../../packages/shared/src/api/address.ts';
import { handleAddressResolve, handleAddressSearch, type AddressDeps } from './address-core.ts';

const allow = async () => ({ allowed: true, reason: null });

function deps(overrides: Partial<AddressDeps> = {}): AddressDeps {
  return {
    environment: 'production',
    placesKey: 'server-places-key',
    geocodingKey: 'server-geocoding-key',
    fetch: vi.fn(async () => new Response('{}')) as unknown as typeof fetch,
    authorize: allow,
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/functions/v1/address-search', {
    method: 'POST',
    headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const search = { query: '100 Main St', session_token: 'session-1234', locale: 'es-US' };

describe('address-search', () => {
  it('maps Places (New) autocomplete suggestions and uses the server key + session token', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        suggestions: [
          {
            placePrediction: {
              placeId: 'ChIJ123',
              structuredFormat: {
                mainText: { text: '100 Main St' },
                secondaryText: { text: 'Houston, TX, USA' },
              },
            },
          },
        ],
      }),
    );
    const response = await handleAddressSearch(
      post(search),
      deps({ fetch: fetchMock as unknown as typeof fetch }),
    );
    expect(response.status).toBe(200);
    const body = AddressSearchResponseSchema.parse(await response.json());
    expect(body.candidates).toEqual([
      { place_id: 'ChIJ123', primary_text: '100 Main St', secondary_text: 'Houston, TX, USA' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('server-places-key');
    expect(JSON.parse(String(init.body))).toMatchObject({
      input: '100 Main St',
      sessionToken: 'session-1234',
      languageCode: 'es',
    });
  });

  it('uses the labelled development fake only in development when no key exists', async () => {
    const response = await handleAddressSearch(
      post(search),
      deps({ environment: 'development', placesKey: null }),
    );
    const body = AddressSearchResponseSchema.parse(await response.json());
    expect(body.provider).toBe('development_fake');
    expect(body.candidates.every((c) => c.secondary_text.includes('not real'))).toBe(true);
  });

  it.each(['staging', 'production'] as const)(
    'fails closed in %s without a server key',
    async (environment) => {
      const response = await handleAddressSearch(
        post(search),
        deps({ environment, placesKey: null }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'CONFIGURATION_ERROR' } });
    },
  );

  it('requires a bearer token, POST, JSON and a valid body', async () => {
    expect((await handleAddressSearch(post(search, { authorization: '' }), deps())).status).toBe(
      401,
    );
    expect(
      (
        await handleAddressSearch(
          new Request('http://x', { method: 'GET', headers: { authorization: 'Bearer t' } }),
          deps(),
        )
      ).status,
    ).toBe(405);
    expect(
      (await handleAddressSearch(post(search, { 'content-type': 'text/plain' }), deps())).status,
    ).toBe(415);
    expect((await handleAddressSearch(post({ ...search, query: 'ab' }), deps())).status).toBe(422);
    expect((await handleAddressSearch(post({ ...search, extra: true }), deps())).status).toBe(422);
  });

  it('maps authorization decisions to 403 and 429 (with Retry-After)', async () => {
    const forbidden = await handleAddressSearch(
      post(search),
      deps({ authorize: async () => ({ allowed: false, reason: 'FORBIDDEN' }) }),
    );
    expect(forbidden.status).toBe(403);
    const limited = await handleAddressSearch(
      post(search),
      deps({ authorize: async () => ({ allowed: false, reason: 'RATE_LIMITED' }) }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('never claims success when the provider fails', async () => {
    const failing = vi.fn(async () => new Response('quota', { status: 429 }));
    const response = await handleAddressSearch(
      post(search),
      deps({ fetch: failing as unknown as typeof fetch }),
    );
    expect(response.status).toBe(503);
    const unreachable = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(
      (
        await handleAddressSearch(
          post(search),
          deps({ fetch: unreachable as unknown as typeof fetch }),
        )
      ).status,
    ).toBe(503);
  });
});

describe('address-resolve', () => {
  const resolve = { place_id: 'ChIJ123', session_token: 'session-1234', locale: 'en-US' };

  it('geocodes the place id with the server key', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: 'OK',
        results: [
          {
            formatted_address: '100 Main St, Houston, TX',
            geometry: { location: { lat: 29.76, lng: -95.37 } },
          },
        ],
      }),
    );
    const response = await handleAddressResolve(
      post(resolve),
      deps({ fetch: fetchMock as unknown as typeof fetch }),
    );
    const body = AddressResolveResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      lat: 29.76,
      lng: -95.37,
      attribution: 'Google',
      provider: 'google',
    });
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain(
      'key=server-geocoding-key',
    );
  });

  it('rejects an unresolvable place without inventing coordinates', async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: 'ZERO_RESULTS', results: [] }));
    expect(
      (
        await handleAddressResolve(
          post(resolve),
          deps({ fetch: fetchMock as unknown as typeof fetch }),
        )
      ).status,
    ).toBe(422);
  });

  it('fails closed in production without the geocoding key', async () => {
    expect((await handleAddressResolve(post(resolve), deps({ geocodingKey: null }))).status).toBe(
      503,
    );
  });
});
