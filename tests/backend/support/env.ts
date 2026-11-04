/**
 * Backend end-to-end tests run against the local Supabase stack (Docker) started by
 * `supabase start` — locally and in the CI `database` job. Values come from
 * `supabase status -o env` (local demo values, never real project secrets). A missing value is a
 * hard failure: these tests never skip silently.
 */
export interface BackendEnv {
  apiUrl: string;
  anonKey: string;
  dbUrl: string;
  mailpitUrl: string;
}

export function backendEnv(): BackendEnv {
  const apiUrl = process.env.API_URL;
  const anonKey = process.env.ANON_KEY;
  const dbUrl = process.env.DB_URL;
  const mailpitUrl = process.env.MAILPIT_URL ?? process.env.INBUCKET_URL;
  const missing = Object.entries({
    API_URL: apiUrl,
    ANON_KEY: anonKey,
    DB_URL: dbUrl,
    MAILPIT_URL: mailpitUrl,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Backend tests need a running local Supabase stack. Missing: ${missing.join(', ')}. ` +
        'Run: eval "$(supabase status -o env | sed \'s/^/export /\')" && npm run test:backend',
    );
  }
  if (!apiUrl?.startsWith('http://127.0.0.1') && !apiUrl?.startsWith('http://localhost')) {
    throw new Error('Backend tests only run against a local stack (refusing a remote API_URL).');
  }
  return {
    apiUrl,
    anonKey: anonKey as string,
    dbUrl: dbUrl as string,
    mailpitUrl: mailpitUrl as string,
  };
}
