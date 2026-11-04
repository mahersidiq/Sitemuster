import { describe, expect, it } from 'vitest';

import { listFiles, readRepoFile } from '../support/repo';

/**
 * Static guardrails over every SQL migration (complements the pgTAP privilege tests, which check
 * the resulting database). Catches the classic RLS mistakes before they reach a database.
 */
const MIGRATIONS = listFiles(['supabase/migrations'], (path) => path.endsWith('.sql'));
const sql = (path: string) =>
  readRepoFile(path)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

describe('migration static scan', () => {
  it('has migrations to scan', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(8);
  });

  it('never grants anything to anon or PUBLIC', () => {
    const offenders = MIGRATIONS.filter((path) =>
      /\bgrant\b[^;]*\bto\b[^;]*\b(anon|public)\b/i.test(sql(path)),
    );
    expect(offenders).toEqual([]);
  });

  it('never writes a blanket USING (true) / WITH CHECK (true) policy', () => {
    const offenders = MIGRATIONS.filter((path) =>
      /(using|with check)\s*\(\s*true\s*\)/i.test(sql(path)),
    );
    expect(offenders).toEqual([]);
  });

  it('never creates client write policies (INSERT/UPDATE/DELETE/ALL)', () => {
    const offenders = MIGRATIONS.filter((path) =>
      /create policy[^;]*\bfor\s+(insert|update|delete|all)\b/i.test(sql(path)),
    );
    expect(offenders).toEqual([]);
  });

  it('pins search_path on every SECURITY DEFINER function', () => {
    const offenders: string[] = [];
    for (const path of MIGRATIONS) {
      for (const fn of sql(path)
        .split(/create (?:or replace )?function/i)
        .slice(1)) {
        const header = fn.split(/\$\$/)[0] ?? '';
        if (/security definer/i.test(header) && !/set search_path\s*=\s*''/i.test(header)) {
          offenders.push(`${path}: ${header.slice(0, 60).trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never disables row level security', () => {
    const offenders = MIGRATIONS.filter((path) => /disable row level security/i.test(sql(path)));
    expect(offenders).toEqual([]);
  });
});
