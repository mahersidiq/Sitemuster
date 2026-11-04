import { rpcReportStore } from '../../../packages/shared/src/reports/generate.ts';
import {
  handleDailyReports,
  reportContextFromJson,
  ReportsAuthError,
} from '../_shared/reports-core.ts';
import { callRpc, postgrestEnvFrom, serviceRpc } from '../_shared/postgrest.ts';
import { logSafe } from '../_shared/log.ts';

// verify_jwt = true (supabase/config.toml). Permissions come from `report_context`,
// `report_list` and `my_pending_reports` called WITH THE CALLER'S OWN JWT; the service role only
// runs the `edge_*` report storage functions with the ids that context derived.
const env = postgrestEnvFrom(Deno.env);
const rpc = serviceRpc(env);
const store = rpcReportStore(rpc);

Deno.serve((req) => {
  const authorization = req.headers.get('authorization') ?? '';
  const asCaller = async (fn: string, args: Record<string, unknown>) => {
    const result = await callRpc(env, fn, args, authorization);
    if (!result.ok) {
      if (result.status === 401) throw new ReportsAuthError('refused');
      throw new Error(`RPC_FAILED:${fn}:${result.status}:${result.code ?? ''}`);
    }
    return result.data;
  };
  return handleDailyReports(req, {
    now: () => Date.now(),
    budget: async () => (await asCaller('consume_report_budget', {})) === true,
    context: async (projectId) =>
      reportContextFromJson(await asCaller('report_context', { p_project_id: projectId })),
    foremanProjects: async () => {
      const rows = ((await asCaller('my_foreman_projects', {})) ?? []) as {
        project_id?: unknown;
      }[];
      return [
        ...new Set(
          rows.flatMap((row) => (typeof row.project_id === 'string' ? [row.project_id] : [])),
        ),
      ];
    },
    gaps: async (projectId, days) => {
      const row = (await rpc('edge_report_gaps', { p_project: projectId, p_days: days })) as {
        dates?: unknown;
      } | null;
      return Array.isArray(row?.dates)
        ? row.dates.filter((d): d is string => typeof d === 'string')
        : [];
    },
    list: async (projectId, localDate) =>
      ((await asCaller('report_list', { p_project_id: projectId, p_local_date: localDate })) ??
        []) as unknown[],
    pending: async () => ((await asCaller('my_pending_reports', {})) ?? []) as unknown[],
    store,
    // Safe structured lines (request id, codes and counts only) for refusals and failures.
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        logSafe(entry);
      }
    },
  });
});
