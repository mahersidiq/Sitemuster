import {
  type CloseRow,
  handleMusterClose,
  MusterAuthError,
  MusterRpcError,
} from '../_shared/muster-core.ts';
import { callRpc, postgrestEnvFrom } from '../_shared/postgrest.ts';

// verify_jwt = true (supabase/config.toml). `close_muster` runs WITH THE CALLER'S OWN JWT: the
// designated safety role closes, acknowledges anyone unresolved and freezes the report.
const env = postgrestEnvFrom(Deno.env);

Deno.serve((req) => {
  const authorization = req.headers.get('authorization') ?? '';
  return handleMusterClose(req, {
    now: () => Date.now(),
    start: () => Promise.reject(new Error('not used')),
    close: async (input) => {
      const result = await callRpc(
        env,
        'close_muster',
        {
          p_muster_id: input.musterId,
          p_note: input.note,
          p_acknowledge_incomplete: input.acknowledge,
        },
        authorization,
      );
      if (!result.ok) {
        if (result.status === 401) throw new MusterAuthError('refused');
        throw new MusterRpcError(result.status, result.code);
      }
      return result.data as CloseRow;
    },
    pushTargets: async () => [],
    recordPush: async () => undefined,
    // Closing sends nothing; the type needs a provider, never used here.
    push: { name: 'none', kind: 'real', send: async () => [] },
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        console.warn(JSON.stringify(entry));
      }
    },
  });
});
