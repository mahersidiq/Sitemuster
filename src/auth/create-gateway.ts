import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { SupabaseSiteMusterApi } from '../api/supabase-api';
import type { SiteMusterApi } from '../api/types';
import type { RuntimeEnv } from '../config/runtime-env';
import type { EncryptedSessionStorage } from './encrypted-storage';
import { SupabaseAuthGateway, type AuthGateway } from './gateway';
import { createNativeSessionStorage } from './native-storage';

export interface AuthBackend {
  gateway: AuthGateway;
  storage: EncryptedSessionStorage;
  api: SiteMusterApi;
}

/**
 * Builds the real Supabase-backed gateway. Returns null only in a development build without a
 * configured backend (staging/production cannot get here without config — decision #51).
 */
export function createAuthBackend(env: RuntimeEnv): AuthBackend | null {
  if (!env.supabaseUrl || !env.supabaseAnonKey) return null;
  const storage = createNativeSessionStorage();
  const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      storage,
      storageKey: 'sitemuster-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  // Refresh tokens only while the app is in the foreground (React Native guidance); background
  // location uploads never depend on this session (decision #13).
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void client.auth.startAutoRefresh();
    else void client.auth.stopAutoRefresh();
  });
  return {
    gateway: new SupabaseAuthGateway(client),
    storage,
    api: new SupabaseSiteMusterApi(client),
  };
}
