import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..');

export function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.expo',
  'dist',
  'coverage',
  'ios',
  'android',
  '.temp',
]);

/** Recursively list files under repo-relative directories matching a filter. */
export function listFiles(dirs: string[], filter: (path: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(absolute, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(REPO_ROOT, full);
        if (filter(rel)) out.push(rel);
      }
    }
  };
  for (const dir of dirs) walk(join(REPO_ROOT, dir));
  return out.sort();
}

/** Files tracked by git (falls back to an empty list outside a git checkout). */
export function gitTrackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    throw new Error('git ls-files failed: security tests must run inside the repository checkout');
  }
}
