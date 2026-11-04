import {
  decodeJwtClaims,
  DeleteAuthError,
  DeleteRpcError,
  type DeletionRow,
  handleAccountDelete,
  sessionFromClaims,
} from '../_shared/account-delete-core.ts';
import { callRpc, postgrestEnvFrom } from '../_shared/postgrest.ts';
import { logSafe } from '../_shared/log.ts';

// verify_jwt = true (supabase/config.toml). Auth verifies the person's token again here (GET
// /auth/v1/user) before its claims are read; the request itself runs as the service role through
// edge_request_account_deletion, which only ever acts on the verified user id.
const env = postgrestEnvFrom(Deno.env);

Deno.serve((req) =>
  handleAccountDelete(req, {
    now: () => Date.now(),
    verify: async (token) => {
      const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
        headers: { authorization: `Bearer ${token}`, apikey: env.anonKey },
      });
      if (!response.ok) throw new DeleteAuthError('refused');
      const user = (await response.json()) as { id?: unknown };
      const claims = decodeJwtClaims(token);
      if (typeof user.id !== 'string' || !claims || claims.sub !== user.id) {
        throw new DeleteAuthError('refused');
      }
      return sessionFromClaims(user.id, claims);
    },
    request: async (userId, aal) => {
      const result = await callRpc(
        env,
        'edge_request_account_deletion',
        { p_user: userId, p_aal: aal },
        'service',
      );
      if (!result.ok) throw new DeleteRpcError(result.status, result.code);
      return result.data as DeletionRow;
    },
    signOutEverywhere: async (token) => {
      const response = await fetch(`${env.supabaseUrl}/auth/v1/logout?scope=global`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, apikey: env.anonKey },
      });
      if (!response.ok) throw new Error(`LOGOUT_${response.status}`);
    },
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        logSafe(entry);
      }
    },
  }),
);
