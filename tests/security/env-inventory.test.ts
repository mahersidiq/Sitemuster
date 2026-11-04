import { describe, expect, it } from 'vitest';

import { listFiles, readRepoFile } from '../support/repo';

/**
 * docs/release/environments.md is the reviewed inventory of every environment value (staging vs
 * production secrets, Milestone 13). Every name production code reads must be listed there, a
 * public `EXPO_PUBLIC_*` name can never be documented as a secret, and the app bundle never reads
 * a server secret.
 */
const DOC = readRepoFile('docs/release/environments.md');
const isTest = (path: string) => /\.test\.(ts|tsx|mts)$/.test(path) || path.includes('/tests/');

function namesIn(paths: string[], patterns: RegExp[]): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const text = readRepoFile(path);
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

const appCode = [
  'app.config.ts',
  ...listFiles(['src', 'app'], (path) => /\.(ts|tsx)$/.test(path) && !isTest(path)),
];
const operatorCode = listFiles(
  ['scripts/operator'],
  (path) => path.endsWith('.mts') && !isTest(path),
);
const edgeCode = listFiles(['supabase/functions'], (path) => path.endsWith('.ts') && !isTest(path));
const workflows = listFiles(['.github/workflows'], (path) => /\.ya?ml$/.test(path));

const APP_NAMES = namesIn(
  [...appCode, ...operatorCode],
  [
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /\benv\.([A-Z][A-Z0-9_]+)\b/g,
    /\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  ],
);
const EDGE_NAMES = namesIn(edgeCode, [/env\.get\(['"]([A-Z][A-Z0-9_]+)['"]\)/g]);
const WORKFLOW_NAMES = namesIn(workflows, [/\b(?:secrets|vars)\.([A-Z][A-Z0-9_]+)/g]);
const EAS_NAMES = new Set(
  Object.values(
    (JSON.parse(readRepoFile('eas.json')) as { build: Record<string, { env?: object }> }).build,
  ).flatMap((profile) => Object.keys(profile.env ?? {})),
);

function documented(name: string): boolean {
  return DOC.includes(`\`${name}\``);
}

/** Table rows of the inventory: [name cell, kind cell]. */
function rows(): [string, string][] {
  const out: [string, string][] = [];
  for (const line of DOC.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length > 3 && cells[1]?.startsWith('`')) out.push([cells[1] ?? '', cells[2] ?? '']);
  }
  return out;
}

describe('environment inventory', () => {
  it('finds the names the code reads', () => {
    expect(APP_NAMES.size).toBeGreaterThanOrEqual(10);
    expect(EDGE_NAMES.size).toBeGreaterThanOrEqual(6);
    expect(WORKFLOW_NAMES.size).toBeGreaterThanOrEqual(6);
  });

  it('documents every value the app build, the operator CLI and the Edge Functions read', () => {
    const missing = [...APP_NAMES, ...EDGE_NAMES, ...WORKFLOW_NAMES, ...EAS_NAMES].filter(
      (name) => !documented(name),
    );
    expect(missing, 'add these to docs/release/environments.md').toEqual([]);
  });

  it('never lists a public EXPO_PUBLIC_ value as a secret', () => {
    const wrong = rows().filter(
      ([name, kind]) => name.includes('EXPO_PUBLIC_') && /^secret/i.test(kind),
    );
    expect(wrong).toEqual([]);
  });

  it('keeps server secrets out of the app bundle code', () => {
    for (const name of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'BADGE_SECRET_ENCRYPTION_KEY',
      'GOOGLE_PLACES_SERVER_KEY',
      'GOOGLE_GEOCODING_SERVER_KEY',
      'EXPO_ACCESS_TOKEN',
      'TWILIO_AUTH_TOKEN',
      'SENTRY_AUTH_TOKEN',
    ]) {
      const readers = appCode
        .filter((path) => path !== 'app.config.ts')
        .filter((path) => readRepoFile(path).includes(name));
      expect(readers, `${name} must never be read by app code`).toEqual([]);
    }
  });

  it('marks the staging and production separations', () => {
    for (const heading of ['staging', 'production', 'development']) {
      expect(DOC).toContain(`**${heading}**`);
    }
    expect(DOC).toContain('com.sitemuster.app.dev');
  });
});
