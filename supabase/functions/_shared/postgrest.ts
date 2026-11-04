/**
 * Minimal PostgREST/Auth calls for Edge Functions (no client library at runtime). User calls carry
 * the caller's own JWT so database functions derive identity themselves; service calls are used
 * only for the few `edge_*` functions granted to service_role (decision #71).
 */
export type RpcResult =
  { ok: true; data: unknown } | { ok: false; status: number; code: string | null };

export interface PostgrestEnv {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

export function postgrestEnvFrom(env: { get(name: string): string | undefined }): PostgrestEnv {
  return {
    supabaseUrl: env.get('SUPABASE_URL') ?? '',
    anonKey: env.get('SUPABASE_ANON_KEY') ?? '',
    serviceRoleKey: env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  };
}

/** Stable machine code from a PostgREST error body (`raise exception 'CODE[: detail]'`). */
export function rpcErrorCode(body: unknown): string | null {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  const match = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message);
  return match?.[1] ?? null;
}

export async function callRpc(
  env: PostgrestEnv,
  fn: string,
  args: Record<string, unknown>,
  authorization: string | 'service',
  fetchImpl: typeof fetch = fetch,
): Promise<RpcResult> {
  const service = authorization === 'service';
  let response: Response;
  try {
    response = await fetchImpl(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: service ? env.serviceRoleKey : env.anonKey,
        authorization: service ? `Bearer ${env.serviceRoleKey}` : authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
  } catch {
    return { ok: false, status: 503, code: null };
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) return { ok: false, status: response.status, code: rpcErrorCode(body) };
  return { ok: true, data: body };
}

/** The caller's user id as confirmed by the Auth server (never decoded from the token locally). */
export async function currentUserId(
  env: PostgrestEnv,
  authorization: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${env.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: env.anonKey, authorization },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: unknown };
    return typeof body.id === 'string' ? body.id : null;
  } catch {
    return null;
  }
}

/** A service-role RPC caller that throws on any failure (callers answer 503, never fake success). */
export function serviceRpc(
  env: PostgrestEnv,
  fetchImpl: typeof fetch = fetch,
): (fn: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (fn, args) => {
    const result = await callRpc(env, fn, args, 'service', fetchImpl);
    if (!result.ok) throw new Error(`RPC_FAILED:${fn}:${result.status}:${result.code ?? ''}`);
    return result.data;
  };
}
