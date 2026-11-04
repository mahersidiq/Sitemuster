import { createClient } from '@supabase/supabase-js';
import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';

import { runOperator, USAGE } from './operator.mts';

/**
 * Entry point: `npm run operator -- <command> … --reason "…"`. Uses only public values plus the
 * operator's own sign-in; refuses plain http except for a local stack.
 */
const url = process.env.SITEMUSTER_SUPABASE_URL ?? '';
const anonKey = process.env.SITEMUSTER_SUPABASE_ANON_KEY ?? '';
const email = process.env.SITEMUSTER_OPERATOR_EMAIL ?? '';
const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url);

if (!url || !anonKey || !email || (!url.startsWith('https://') && !local)) {
  console.log(USAGE);
  process.exit(2);
}

const client = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const rl = readline.createInterface({ input: stdin, output: stdout });
const code = await runOperator(process.argv.slice(2), {
  client,
  email,
  io: { prompt: (question) => rl.question(question), print: (line) => console.log(line) },
});
rl.close();
process.exit(code);
