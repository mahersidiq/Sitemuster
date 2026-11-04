import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { backendEnv } from './env';

/** A fresh, isolated client (in-memory session) — like one phone. */
export function newClient(): SupabaseClient {
  const { apiUrl, anonKey } = backendEnv();
  return createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function uniquePhone(): string {
  const n = Math.floor(Math.random() * 9_000_000) + 1_000_000;
  return `+1555${n}`;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.test`;
}
