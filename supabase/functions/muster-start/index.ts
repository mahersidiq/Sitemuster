import { functionEnvironment } from '../_shared/http.ts';
import {
  handleMusterStart,
  MusterAuthError,
  MusterRpcError,
  pushTargetsFromJson,
  type StartRow,
} from '../_shared/muster-core.ts';
import { callRpc, postgrestEnvFrom, serviceRpc } from '../_shared/postgrest.ts';
import { pushProviderFor } from '../_shared/push.ts';

// verify_jwt = true (supabase/config.toml). `start_muster` runs WITH THE CALLER'S OWN JWT: the
// database checks the designated safety role (with MFA) and freezes the snapshot. The service role
// only reads push targets and records delivery outcomes.
const env = postgrestEnvFrom(Deno.env);
const rpc = serviceRpc(env);
const push = pushProviderFor(
  functionEnvironment(Deno.env.get('SITEMUSTER_ENV')),
  fetch,
  Deno.env.get('EXPO_ACCESS_TOKEN') || null,
);

Deno.serve((req) => {
  const authorization = req.headers.get('authorization') ?? '';
  return handleMusterStart(req, {
    now: () => Date.now(),
    start: async (input) => {
      const result = await callRpc(
        env,
        'start_muster',
        {
          p_project_id: input.projectId,
          p_incident_label: input.label,
          p_idempotency_key: input.idempotencyKey,
          p_separate: input.separate,
        },
        authorization,
      );
      if (!result.ok) {
        if (result.status === 401) throw new MusterAuthError('refused');
        throw new MusterRpcError(result.status, result.code);
      }
      return result.data as StartRow;
    },
    close: () => Promise.reject(new Error('not used')),
    pushTargets: async (musterId) =>
      pushTargetsFromJson(await rpc('edge_muster_push_targets', { p_muster: musterId })),
    recordPush: async (musterId, results) => {
      await rpc('edge_muster_record_push', { p_muster: musterId, p_results: results });
    },
    push,
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        console.warn(JSON.stringify(entry));
      }
    },
  });
});
