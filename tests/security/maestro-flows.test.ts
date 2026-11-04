import { describe, expect, it } from 'vitest';

import { listFiles, readRepoFile } from '../support/repo';

/**
 * The Maestro release smoke flows (decision #151) refer only to test ids and texts that exist, so
 * a renamed screen breaks this test instead of silently breaking the flow on a device.
 */
const flows = listFiles(['.maestro'], (path) => path.endsWith('.yaml'));
const appSource = listFiles(['app', 'src'], (path) => path.endsWith('.tsx'))
  .map((path) => readRepoFile(path))
  .join('\n');
const en = JSON.stringify(JSON.parse(readRepoFile('src/i18n/locales/en-US.json')));
const es = JSON.stringify(JSON.parse(readRepoFile('src/i18n/locales/es-US.json')));

describe('Maestro flows', () => {
  it('exist and target the staging app id', () => {
    expect(flows.length).toBeGreaterThanOrEqual(2);
    for (const flow of flows) expect(readRepoFile(flow)).toContain('appId: com.sitemuster.app.dev');
  });

  it('use only test ids the app defines and texts the dictionaries contain', () => {
    let checked = 0;
    for (const flow of flows) {
      const text = readRepoFile(flow);
      for (const [, id] of text.matchAll(/id: ['"]([^'"]+)['"]/g)) {
        const literal = appSource.includes(`testID="${id}"`);
        const templated =
          /^choose-/.test(id ?? '') && appSource.includes('testID={`choose-${locale}`}');
        expect(literal || templated, `${flow}: ${id}`).toBe(true);
        checked += 1;
      }
      for (const [, label] of text.matchAll(/assertVisible: ['"]([^'"]+)['"]/g)) {
        expect(en.includes(label ?? '') || es.includes(label ?? ''), `${flow}: ${label}`).toBe(
          true,
        );
        checked += 1;
      }
    }
    // Never pass vacuously: every flow line above was really checked.
    expect(checked).toBeGreaterThanOrEqual(12);
  });
});
