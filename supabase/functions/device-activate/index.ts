import { reconcile } from '../../../packages/shared/src/attendance/reconcile.ts';
import { RpcAttendanceStore } from '../../../packages/shared/src/attendance/store-codec.ts';
import { iso } from '../../../packages/shared/src/attendance/time.ts';
import { handleDeviceActivate } from '../_shared/device-core.ts';
import { functionEnvironment } from '../_shared/http.ts';
import { callRpc, currentUserId, postgrestEnvFrom, serviceRpc } from '../_shared/postgrest.ts';
import { logSafe } from '../_shared/log.ts';

const env = postgrestEnvFrom(Deno.env);
const rpc = serviceRpc(env);
const store = new RpcAttendanceStore(rpc);
Deno.serve((req) =>
  handleDeviceActivate(req, {
    environment: functionEnvironment(Deno.env.get('SITEMUSTER_ENV')),
    badgeKey: Deno.env.get('BADGE_SECRET_ENCRYPTION_KEY') ?? null,
    userId: (authorization) => currentUserId(env, authorization),
    activate: (args) => callRpc(env, 'edge_activate_device', args, 'service'),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    newDeviceId: () => crypto.randomUUID(),
    openSessionProjects: async (workerId) =>
      ((await rpc('edge_worker_open_session_projects', { p_worker: workerId })) as string[]) ?? [],
    flagReplacement: async (evidence) => {
      await reconcile(store, evidence, iso(Date.now()));
    },
    // Safe structured lines (ids truncated, codes and counts only) for refusals and failures;
    // every invocation's status is already in the platform's function logs.
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        logSafe(entry);
      }
    },
  }),
);
