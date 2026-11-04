import { describe, expect, it } from 'vitest';

import { gitTrackedFiles, readRepoFile } from '../support/repo';

describe('secrets never committed', () => {
  it('git-ignores every .env file except .env.example', () => {
    const gitignore = readRepoFile('.gitignore');
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^\.env\.\*$/m);
    expect(gitignore).toMatch(/^!\.env\.example$/m);
  });

  it('tracks no .env file other than .env.example', () => {
    const tracked = gitTrackedFiles().filter((path) => /(^|\/)\.env(\.|$)/.test(path));
    expect(tracked.filter((path) => !path.endsWith('.env.example'))).toEqual([]);
  });

  it('tracks no signing keys, keystores or service-account files', () => {
    const tracked = gitTrackedFiles().filter((path) =>
      /\.(p8|p12|jks|keystore|mobileprovision)$|google-services\.json$|GoogleService-Info\.plist$/.test(
        path,
      ),
    );
    expect(tracked).toEqual([]);
  });

  it('keeps .env.example free of values for server-only secrets', () => {
    const example = readRepoFile('.env.example');
    const assigned = example
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=.+$/.test(line))
      .map((line) => line.split('=')[0]);
    expect(assigned).toEqual(['APP_ENV']);
  });
});
