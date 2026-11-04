import { RpcAttendanceStore } from '../../../packages/shared/src/attendance/store-codec.ts';
import { iso } from '../../../packages/shared/src/attendance/time.ts';
import { toPgHex } from '../_shared/badge-crypto.ts';
import { deviceAuthFromJson, handleIngest } from '../_shared/ingest-core.ts';
import { postgrestEnvFrom, serviceRpc } from '../_shared/postgrest.ts';
import { logSafe } from '../_shared/log.ts';

// verify_jwt=false for THIS function only (supabase/config.toml): the device bearer secret is
// verified here, and every database call is scoped to the ids derived from it (decision #39).
const rpc = serviceRpc(postgrestEnvFrom(Deno.env));
const store = new RpcAttendanceStore(rpc);

Deno.serve((req) =>
  handleIngest(req, {
    now: () => iso(Date.now()),
    authenticate: async (hash) =>
      deviceAuthFromJson(await rpc('edge_device_authenticate', { p_token_hash: toPgHex(hash) })),
    rateLimit: async (deviceId, events) =>
      (await rpc('edge_device_rate_limit', { p_device: deviceId, p_events: events })) === true,
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
    // Safe structured lines (ids truncated, codes and counts only) for refusals and failures;
    // every invocation's status is already in the platform's function logs.
    log: (entry) => {
      if (Number(entry.status ?? 200) >= 400 || String(entry.outcome).includes('fail')) {
        logSafe(entry);
      }
    },
  }),
);
