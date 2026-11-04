import {
  confirmResultFromJson,
  handleReportConfirm,
  reportContextFromJson,
  reportRefFromJson,
  ReportsAuthError,
  ReportsRpcError,
} from '../_shared/reports-core.ts';
import { callRpc, postgrestEnvFrom, serviceRpc } from '../_shared/postgrest.ts';

// verify_jwt = true (supabase/config.toml). The foreman's identity and company come from
// `report_context` called WITH THEIR OWN JWT; `edge_confirm_report` (service role) re-checks the
// foreman by user id inside the same transaction that records the answer.
const env = postgrestEnvFrom(Deno.env);
const rpc = serviceRpc(env);

Deno.serve((req) => {
  const authorization = req.headers.get('authorization') ?? '';
  return handleReportConfirm(req, {
    now: () => Date.now(),
    context: async (projectId) => {
      const result = await callRpc(
        env,
        'report_context',
        { p_project_id: projectId },
        authorization,
      );
      if (!result.ok) {
        if (result.status === 401) throw new ReportsAuthError('refused');
        throw new Error(`RPC_FAILED:report_context:${result.status}`);
      }
      return reportContextFromJson(result.data);
    },
    ref: async (reportId) =>
      reportRefFromJson(await rpc('edge_report_ref', { p_report_id: reportId })),
    confirm: async (input) => {
      const result = await callRpc(
        env,
        'edge_confirm_report',
        {
          p_report_id: input.reportId,
          p_version: input.version,
          p_action: input.action,
          p_comment: input.comment,
          p_proposed: input.proposed,
          p_event_uuid: input.eventUuid,
          p_actor: input.actorId,
          p_now: input.now,
        },
        'service',
      );
      if (!result.ok) throw new ReportsRpcError(result.status, result.code);
      return confirmResultFromJson(result.data);
    },
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        console.warn(JSON.stringify(entry));
      }
    },
  });
});
