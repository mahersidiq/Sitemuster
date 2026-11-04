import { RpcAttendanceStore } from '../../../packages/shared/src/attendance/store-codec.ts';
import {
  DemoAuthError,
  demoContextFromJson,
  DemoRpcError,
  handleDemoSimulate,
} from '../_shared/demo-core.ts';
import { callRpc, postgrestEnvFrom, serviceRpc } from '../_shared/postgrest.ts';
import { logSafe } from '../_shared/log.ts';

// verify_jwt = true (supabase/config.toml). `begin_demo_simulation` runs WITH THE CALLER'S OWN JWT:
// the database checks MFA, the project role, the demo allowlist and the synthetic person. The
// service role then only reads the synthetic phone record and runs the production ingest pipeline
// for it (decision #140).
const env = postgrestEnvFrom(Deno.env);
const rpc = serviceRpc(env);
const store = new RpcAttendanceStore(rpc);

Deno.serve((req) => {
  const authorization = req.headers.get('authorization') ?? '';
  return handleDemoSimulate(req, {
    now: () => Date.now(),
    begin: async (input) => {
      const result = await callRpc(
        env,
        'begin_demo_simulation',
        {
          p_project_id: input.projectId,
          p_worker_id: input.workerId,
          p_action: input.action,
          p_idempotency_key: input.idempotencyKey,
        },
        authorization,
      );
      if (!result.ok) {
        if (result.status === 401) throw new DemoAuthError('refused');
        throw new DemoRpcError(result.status, result.code);
      }
      const context = demoContextFromJson(result.data);
      if (!context) throw new Error('DEMO_CONTEXT_INVALID');
      return context;
    },
    device: (deviceId) => rpc('edge_demo_device', { p_device: deviceId }),
    receipts: async (deviceId, uuids) => {
      const rows = (await rpc('edge_location_receipt_lookup', {
        p_device: deviceId,
        p_event_uuids: uuids,
      })) as { event_uuid: string; same_device: boolean }[];
      return new Map(rows.map((row) => [row.event_uuid, row.same_device === true]));
    },
    recordTerminals: async (requestId, receipts, quarantine) => {
      await rpc('edge_record_location_terminals', {
        p_request_id: requestId,
        p_receipts: receipts,
        p_quarantine: quarantine,
      });
    },
    store,
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        logSafe(entry);
      }
    },
  });
});
