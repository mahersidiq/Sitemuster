import {
  applyVisitorOperation,
  RpcAttendanceStore,
} from '../../../packages/shared/src/attendance/store-codec.ts';
import { resolveBadgeKey } from '../_shared/badge-crypto.ts';
import { functionEnvironment } from '../_shared/http.ts';
import {
  badgeDeviceFromJson,
  contextFromJson,
  correctionRequestFromJson,
  handleOperations,
  OperationsAuthError,
  receiptsFromJson,
  type VisitorRegistration,
  kioskFromJson,
  printedBadgeFromJson,
  workerFactsFromJson,
} from '../_shared/operations-core.ts';
import { callRpc, postgrestEnvFrom, serviceRpc } from '../_shared/postgrest.ts';

// verify_jwt = true (supabase/config.toml). The caller's permissions come from
// `operation_context` called WITH THEIR OWN JWT; the service role is used only for the
// `edge_*` functions and the reconciler, always with the ids that context derived.
const env = postgrestEnvFrom(Deno.env);
const rpc = serviceRpc(env);
const store = new RpcAttendanceStore(rpc);
const key = resolveBadgeKey(
  functionEnvironment(Deno.env.get('SITEMUSTER_ENV')),
  Deno.env.get('BADGE_SECRET_ENCRYPTION_KEY'),
);

Deno.serve((req) => {
  const authorization = req.headers.get('authorization') ?? '';
  return handleOperations(req, {
    now: () => Date.now(),
    badgeKey: key.ok ? key.key : null,
    context: async (projectId) => {
      const result = await callRpc(
        env,
        'operation_context',
        { p_project_id: projectId },
        authorization,
      );
      if (!result.ok) {
        if (result.status === 401 || result.status === 403)
          throw new OperationsAuthError('refused');
        throw new Error(`RPC_FAILED:operation_context:${result.status}`);
      }
      return contextFromJson(result.data);
    },
    rateLimit: async (actorId, operations) =>
      (await rpc('edge_operation_rate_limit', { p_actor: actorId, p_events: operations })) === true,
    receipts: async (uuids) =>
      receiptsFromJson(await rpc('edge_operation_receipts', { p_event_uuids: uuids })),
    recordReceipts: async (requestId, rows) => {
      await rpc('edge_record_operation_receipts', { p_request_id: requestId, p_rows: rows });
    },
    kiosk: async (kioskDeviceId) =>
      kioskFromJson(await rpc('edge_kiosk_device', { p_kiosk_device_id: kioskDeviceId })),
    loadBadgeDevice: async (deviceId) =>
      badgeDeviceFromJson(await rpc('edge_badge_device', { p_device_id: deviceId })),
    redeemBadgeStep: async (input) =>
      (await rpc('edge_redeem_badge_step', {
        p_project_id: input.projectId,
        p_device_id: input.deviceId,
        p_time_step: input.timeStep,
        p_event_uuid: input.eventUuid,
        p_operator_id: input.actorId,
        p_kiosk_device_id: input.kioskDeviceId,
      })) as 'accepted' | 'duplicate' | 'replay',
    printedBadge: async (hashHex) =>
      printedBadgeFromJson(
        await rpc('edge_printed_badge_worker', { p_code_sha256: `\\x${hashHex}` }),
      ),
    workers: async (projectId, workerIds) =>
      workerFactsFromJson(
        await rpc('edge_operation_workers', { p_project_id: projectId, p_worker_ids: workerIds }),
      ),
    registerVisitor: async (input) =>
      (await rpc('edge_visitor_register', {
        p_project_id: input.projectId,
        p_visitor_id: input.visitorId,
        p_name: input.name,
        p_organization: input.organization,
        p_host_user_id: input.hostUserId,
        p_purpose: input.purpose,
        p_actor: input.actorId,
      })) as VisitorRegistration,
    applyVisitor: (input) => applyVisitorOperation(rpc, input),
    correctionRequest: async (requestId) =>
      correctionRequestFromJson(await rpc('edge_correction_request', { p_request_id: requestId })),
    store,
    // Safe structured lines (request id, codes and counts only) for refusals and failures.
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        console.warn(JSON.stringify(entry));
      }
    },
  });
});
