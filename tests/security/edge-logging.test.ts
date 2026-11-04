import { describe, expect, it } from 'vitest';

import { listFiles, readRepoFile } from '../support/repo';

/**
 * Edge Function logs never carry GPS data, contacts, codes or credentials (spec 09 "Do not include
 * GPS data in … HTTP error logs"). Every function logs through `_shared/log.ts`, which runs the
 * shared scrubber; any other console call is a finding.
 */
const SOURCES = listFiles(
  ['supabase/functions'],
  (path) => path.endsWith('.ts') && !path.endsWith('.test.ts'),
);

describe('Edge Function logging', () => {
  it('has functions to scan', () => {
    expect(SOURCES.length).toBeGreaterThan(20);
  });

  it('only _shared/log.ts writes to the console, and it scrubs first', () => {
    const offenders = SOURCES.filter(
      (path) =>
        path !== 'supabase/functions/_shared/log.ts' && /\bconsole\./.test(readRepoFile(path)),
    );
    expect(offenders).toEqual([]);
    expect(readRepoFile('supabase/functions/_shared/log.ts')).toMatch(
      /console\.warn\(JSON\.stringify\(redact\(entry\)\)\)/,
    );
  });

  it('every function that logs imports the safe logger', () => {
    const entryPoints = SOURCES.filter((path) => path.endsWith('/index.ts'));
    const logging = entryPoints.filter((path) => /\blog\s*:/.test(readRepoFile(path)));
    expect(logging.length).toBeGreaterThanOrEqual(9);
    for (const path of logging) {
      expect(readRepoFile(path), path).toMatch(
        /import \{ logSafe \} from '\.\.\/_shared\/log\.ts'/,
      );
    }
  });
});
