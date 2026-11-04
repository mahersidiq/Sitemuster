import { functionEnvironment } from './http.ts';
import type { AddressDeps } from './address-core.ts';

/** Deno-side wiring: secrets come from Edge Function secrets (never from the request). */
export function addressDepsFromEnv(env: { get(name: string): string | undefined }): AddressDeps {
  const supabaseUrl = env.get('SUPABASE_URL') ?? '';
  const anonKey = env.get('SUPABASE_ANON_KEY') ?? '';
  return {
    environment: functionEnvironment(env.get('SITEMUSTER_ENV')),
    placesKey: env.get('GOOGLE_PLACES_SERVER_KEY') || null,
    geocodingKey: env.get('GOOGLE_GEOCODING_SERVER_KEY') || null,
    fetch,
    authorize: async (authorization) => {
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/address_lookup_allowed`, {
        method: 'POST',
        headers: { apikey: anonKey, authorization, 'content-type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) return { allowed: false, reason: 'FORBIDDEN' };
      return (await response.json()) as { allowed: boolean; reason: string | null };
    },
  };
}
