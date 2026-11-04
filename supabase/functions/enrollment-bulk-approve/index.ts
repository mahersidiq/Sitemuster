import { handleEnrollmentBulkApprove } from '../_shared/orientation-core.ts';
import { callRpc, postgrestEnvFrom } from '../_shared/postgrest.ts';

const env = postgrestEnvFrom(Deno.env);
Deno.serve((req) =>
  handleEnrollmentBulkApprove(req, {
    rpc: (fn, args, authorization) => callRpc(env, fn, args, authorization),
  }),
);
