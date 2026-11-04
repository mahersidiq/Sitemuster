import * as Sentry from '@sentry/react-native';

import { scrubBreadcrumb, scrubEvent } from '@sitemuster/shared';

import type { RuntimeEnv } from '../config/runtime-env';

/**
 * Crash monitoring with privacy scrubbing (no coordinates, contacts, OTPs, tokens, badge payloads,
 * names or screenshots). Without a DSN (development) monitoring stays off; production builds
 * cannot be configured without a DSN (app.config.ts and runtime-env fail closed).
 */
export function initMonitoring(env: RuntimeEnv): boolean {
  if (!env.sentryDsn) return false;
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.appEnv,
    sendDefaultPii: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    maxBreadcrumbs: 50,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
  return true;
}
