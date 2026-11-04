import { handleDeviceActivate } from '../_shared/device-core.ts';
import { functionEnvironment } from '../_shared/http.ts';
import { callRpc, currentUserId, postgrestEnvFrom } from '../_shared/postgrest.ts';

const env = postgrestEnvFrom(Deno.env);
Deno.serve((req) =>
  handleDeviceActivate(req, {
    environment: functionEnvironment(Deno.env.get('SITEMUSTER_ENV')),
    badgeKey: Deno.env.get('BADGE_SECRET_ENCRYPTION_KEY') ?? null,
    userId: (authorization) => currentUserId(env, authorization),
    activate: (args) => callRpc(env, 'edge_activate_device', args, 'service'),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    newDeviceId: () => crypto.randomUUID(),
  }),
);
