import {
  AddressResolveRequestSchema,
  AddressSearchRequestSchema,
  type AddressResolveResponse,
  type AddressSearchResponse,
} from '../../../packages/shared/src/api/address.ts';
import { FakeAddressProvider } from '../../../packages/shared/src/providers/fakes.ts';
import { apiError, json, newRequestId, readJsonBody, type FunctionEnvironment } from './http.ts';

/**
 * Address search/resolve through Google Places (New) Autocomplete and Geocoding with SERVER keys
 * held only in Edge Function secrets (decision #30; never in the app). Staff-only, MFA, rate-limited
 * in the database. Without keys: the typed development fake in development; otherwise fail closed.
 */
export interface AddressDeps {
  environment: FunctionEnvironment;
  placesKey: string | null;
  geocodingKey: string | null;
  fetch: typeof fetch;
  /** Calls public.address_lookup_allowed() with the caller's own JWT (authorization + rate limit). */
  authorize: (authorization: string) => Promise<{ allowed: boolean; reason: string | null }>;
}

type Guard = { ok: true; requestId: string; body: unknown } | { ok: false; response: Response };

async function guard(req: Request, deps: AddressDeps): Promise<Guard> {
  const requestId = newRequestId();
  const authorization = req.headers.get('authorization') ?? '';
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return { ok: false, response: apiError(401, 'UNAUTHENTICATED', requestId, 'Sign in first.') };
  }
  const read = await readJsonBody(req, requestId);
  if (!read.ok) return read;
  let decision: { allowed: boolean; reason: string | null };
  try {
    decision = await deps.authorize(authorization);
  } catch {
    return {
      ok: false,
      response: apiError(503, 'TEMPORARILY_UNAVAILABLE', requestId, 'Try again shortly.'),
    };
  }
  if (!decision.allowed) {
    return decision.reason === 'RATE_LIMITED'
      ? {
          ok: false,
          response: apiError(429, 'RATE_LIMITED', requestId, 'Too many lookups.', {
            'retry-after': '60',
          }),
        }
      : { ok: false, response: apiError(403, 'FORBIDDEN', requestId, 'Not allowed.') };
  }
  return { ok: true, requestId, body: read.body };
}

function language(locale: 'en-US' | 'es-US'): string {
  return locale === 'es-US' ? 'es' : 'en';
}

export async function handleAddressSearch(req: Request, deps: AddressDeps): Promise<Response> {
  const checked = await guard(req, deps);
  if (!checked.ok) return checked.response;
  const parsed = AddressSearchRequestSchema.safeParse(checked.body);
  if (!parsed.success)
    return apiError(422, 'INVALID_REQUEST', checked.requestId, 'Invalid search request.');
  const { query, session_token: sessionToken, locale } = parsed.data;

  if (!deps.placesKey) {
    if (deps.environment !== 'development') {
      return apiError(
        503,
        'CONFIGURATION_ERROR',
        checked.requestId,
        'Address search is not configured.',
      );
    }
    const fake = new FakeAddressProvider('development');
    const candidates = await fake.search(query, sessionToken, locale);
    const body: AddressSearchResponse = {
      schema_version: 1,
      request_id: checked.requestId,
      provider: 'development_fake',
      candidates: candidates.map((c) => ({
        place_id: c.placeId,
        primary_text: c.primaryText,
        secondary_text: c.secondaryText,
      })),
    };
    return json(200, body);
  }

  let response: Response;
  try {
    response = await deps.fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': deps.placesKey,
        'x-goog-fieldmask':
          'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat',
      },
      body: JSON.stringify({ input: query, sessionToken, languageCode: language(locale) }),
    });
  } catch {
    return apiError(
      503,
      'TEMPORARILY_UNAVAILABLE',
      checked.requestId,
      'Address provider unreachable.',
    );
  }
  if (!response.ok)
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', checked.requestId, 'Address provider error.');
  const data = (await response.json()) as {
    suggestions?: {
      placePrediction?: {
        placeId?: string;
        structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
      };
    }[];
  };
  const candidates = (data.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId))
    .slice(0, 10)
    .map((p) => ({
      place_id: p.placeId ?? '',
      primary_text: p.structuredFormat?.mainText?.text ?? '',
      secondary_text: p.structuredFormat?.secondaryText?.text ?? '',
    }));
  const body: AddressSearchResponse = {
    schema_version: 1,
    request_id: checked.requestId,
    provider: 'google',
    candidates,
  };
  return json(200, body);
}

export async function handleAddressResolve(req: Request, deps: AddressDeps): Promise<Response> {
  const checked = await guard(req, deps);
  if (!checked.ok) return checked.response;
  const parsed = AddressResolveRequestSchema.safeParse(checked.body);
  if (!parsed.success)
    return apiError(422, 'INVALID_REQUEST', checked.requestId, 'Invalid resolve request.');
  const { place_id: placeId, session_token: sessionToken, locale } = parsed.data;

  if (!deps.geocodingKey) {
    if (deps.environment !== 'development') {
      return apiError(
        503,
        'CONFIGURATION_ERROR',
        checked.requestId,
        'Address lookup is not configured.',
      );
    }
    const resolved = await new FakeAddressProvider('development').resolve(placeId, sessionToken);
    const body: AddressResolveResponse = {
      schema_version: 1,
      request_id: checked.requestId,
      provider: 'development_fake',
      place_id: resolved.placeId,
      formatted_address: resolved.formattedAddress,
      lat: resolved.lat,
      lng: resolved.lng,
      attribution: resolved.attribution,
    };
    return json(200, body);
  }

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('language', language(locale));
  url.searchParams.set('key', deps.geocodingKey);
  let response: Response;
  try {
    response = await deps.fetch(url.toString(), { method: 'GET' });
  } catch {
    return apiError(
      503,
      'TEMPORARILY_UNAVAILABLE',
      checked.requestId,
      'Address provider unreachable.',
    );
  }
  if (!response.ok)
    return apiError(503, 'TEMPORARILY_UNAVAILABLE', checked.requestId, 'Address provider error.');
  const data = (await response.json()) as {
    status?: string;
    results?: {
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
    }[];
  };
  const first = data.results?.[0];
  const lat = first?.geometry?.location?.lat;
  const lng = first?.geometry?.location?.lng;
  if (data.status !== 'OK' || typeof lat !== 'number' || typeof lng !== 'number') {
    return apiError(422, 'INVALID_REQUEST', checked.requestId, 'Address could not be resolved.');
  }
  const body: AddressResolveResponse = {
    schema_version: 1,
    request_id: checked.requestId,
    provider: 'google',
    place_id: placeId,
    formatted_address: first?.formatted_address ?? '',
    lat,
    lng,
    attribution: 'Google',
  };
  return json(200, body);
}
