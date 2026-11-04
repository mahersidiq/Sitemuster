import { describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { RuntimeEnv } from '../config/runtime-env';
import { DevPreviewNotAllowedError, SessionProvider, useSession } from './session';

const env = (appEnv: RuntimeEnv['appEnv']): RuntimeEnv => ({
  appEnv,
  supabaseUrl: appEnv === 'development' ? null : 'https://x.supabase.co',
  supabaseAnonKey: appEnv === 'development' ? null : 'anon',
  sentryDsn: appEnv === 'production' ? 'https://k@o0.ingest.sentry.io/0' : null,
});

function wrapperFor(runtime: RuntimeEnv) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <SessionProvider env={runtime}>{children}</SessionProvider>;
  };
}

describe('SessionProvider role preview guard', () => {
  it('allows the role preview in development builds', async () => {
    const { result } = await renderHook(() => useSession(), {
      wrapper: wrapperFor(env('development')),
    });
    expect(result.current.devPreviewAvailable).toBe(true);
    await act(async () => result.current.enterPreview('worker'));
    expect(result.current.previewRole).toBe('worker');
    await act(async () => result.current.exitPreview());
    expect(result.current.previewRole).toBeNull();
  });

  it.each(['staging', 'production'] as const)(
    'refuses the role preview in %s builds',
    async (appEnv) => {
      const { result } = await renderHook(() => useSession(), { wrapper: wrapperFor(env(appEnv)) });
      expect(result.current.devPreviewAvailable).toBe(false);
      expect(() => result.current.enterPreview('staff')).toThrow(DevPreviewNotAllowedError);
      expect(result.current.previewRole).toBeNull();
    },
  );
});
