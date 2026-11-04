import type { Locale } from '@sitemuster/shared';

import enUS from './locales/en-US.json';
import esUS from './locales/es-US.json';

/** Bundled UI dictionaries. Legal/consent texts are NOT here: they are versioned, reviewed records. */
export const resources: Record<Locale, { translation: typeof enUS }> = {
  'en-US': { translation: enUS },
  'es-US': { translation: esUS },
};
