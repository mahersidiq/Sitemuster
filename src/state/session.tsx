import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { isDevelopmentOnlyFeatureEnabled, type RuntimeEnv } from '../config/runtime-env';

/**
 * Session context. Milestone 01 has NO authentication: the only way into a role shell is the
 * development-only preview, which throws outside development builds. Milestone 03 replaces the
 * preview with real Supabase sessions and server-derived roles.
 */
export type PreviewRole = 'worker' | 'staff';

interface SessionState {
  env: RuntimeEnv;
  previewRole: PreviewRole | null;
  devPreviewAvailable: boolean;
  enterPreview: (role: PreviewRole) => void;
  exitPreview: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

export class DevPreviewNotAllowedError extends Error {
  constructor() {
    super('Role preview is a development-only feature.');
    this.name = 'DevPreviewNotAllowedError';
  }
}

export function SessionProvider({ env, children }: { env: RuntimeEnv; children: ReactNode }) {
  const [previewRole, setPreviewRole] = useState<PreviewRole | null>(null);
  const devPreviewAvailable = isDevelopmentOnlyFeatureEnabled(env);

  const enterPreview = useCallback(
    (role: PreviewRole) => {
      if (!devPreviewAvailable) throw new DevPreviewNotAllowedError();
      setPreviewRole(role);
    },
    [devPreviewAvailable],
  );
  const exitPreview = useCallback(() => setPreviewRole(null), []);

  const value = useMemo(
    () => ({ env, previewRole, devPreviewAvailable, enterPreview, exitPreview }),
    [env, previewRole, devPreviewAvailable, enterPreview, exitPreview],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
