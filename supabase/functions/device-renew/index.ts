import { handleDeviceRenew } from '../_shared/renew-core.ts';
import { callRpc, currentUserId, postgrestEnvFrom } from '../_shared/postgrest.ts';
import { logSafe } from '../_shared/log.ts';

// verify_jwt=false (supabase/config.toml): the SDK presents the device secret, not a JWT; a
// Supabase session, when used, is confirmed by the Auth server inside the handler.
const env = postgrestEnvFrom(Deno.env);
Deno.serve((req) =>
  handleDeviceRenew(req, {
    userId: (authorization) => currentUserId(env, authorization),
    renew: (args) => callRpc(env, 'edge_device_renew', args, 'service'),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    // Safe structured lines (ids truncated, codes and counts only) for refusals and failures;
    // every invocation's status is already in the platform's function logs.
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        logSafe(entry);
      }
    },
  }),
);
