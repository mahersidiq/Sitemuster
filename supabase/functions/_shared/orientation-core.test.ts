import { describe, expect, it } from 'vitest';

import {
  handleEnrollmentBulkApprove,
  handleOrientationSession,
  type StaffRpcDeps,
} from './orientation-core.ts';
import type { RpcResult } from './postgrest.ts';

const PROJECT = '16fd2706-8baf-433b-82eb-8c7fada847da';
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function request(body: unknown, authorization = 'Bearer staff-jwt') {
  return new Request('http://edge/fn', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deps(result: RpcResult) {
  const calls: { fn: string; args: Record<string, unknown>; authorization: string }[] = [];
  const d: StaffRpcDeps = {
    rpc: async (fn, args, authorization) => {
      calls.push({ fn, args, authorization });
      return result;
    },
  };
  return { d, calls };
}

const session = {
  session_id: SESSION,
  project_id: PROJECT,
  starts_at: '2026-11-04T14:00:00Z',
  expires_at: '2026-11-04T16:00:00Z',
  rotating_secret: 'A'.repeat(43),
  static_code: 'B'.repeat(43),
};

describe('orientation-session', () => {
  it('starts a session with the caller JWT and returns the display secrets', async () => {
    const { d, calls } = deps({ ok: true, data: session });
    const response = await handleOrientationSession(
      request({ action: 'START', project_id: PROJECT, idempotency_key: KEY }),
      d,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { session: unknown }).session).toEqual(session);
    expect(calls[0]).toEqual({
      fn: 'start_orientation_session',
      args: { p_project_id: PROJECT, p_idempotency_key: KEY },
      authorization: 'Bearer staff-jwt',
    });
  });

  it('closes a session and maps refusals', async () => {
    expect(
      (
        await handleOrientationSession(
          request({ action: 'CLOSE', project_id: PROJECT, session_id: SESSION }),
          deps({ ok: true, data: null }).d,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleOrientationSession(
          request({ action: 'START', project_id: PROJECT, idempotency_key: KEY }),
          deps({ ok: false, status: 403, code: 'FORBIDDEN' }).d,
        )
      ).status,
    ).toBe(403);
    const inactive = await handleOrientationSession(
      request({ action: 'START', project_id: PROJECT, idempotency_key: KEY }),
      deps({ ok: false, status: 400, code: 'PROJECT_NOT_ACTIVE' }).d,
    );
    expect(inactive.status).toBe(422);
    expect(((await inactive.json()) as { error: { code: string } }).error.code).toBe(
      'PROJECT_NOT_ACTIVE',
    );
    expect(
      (
        await handleOrientationSession(
          request({ action: 'START', project_id: PROJECT }),
          deps({ ok: true, data: session }).d,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await handleOrientationSession(
          request({ action: 'START', project_id: PROJECT, idempotency_key: KEY }, ''),
          deps({ ok: true, data: session }).d,
        )
      ).status,
    ).toBe(401);
  });
});

describe('enrollment-bulk-approve', () => {
  it('returns one result per enrollment and refuses more than 100', async () => {
    const ids = [KEY, SESSION];
    const results = ids.map((id) => ({ enrollment_id: id, result: 'APPROVED' }));
    const { d, calls } = deps({ ok: true, data: results });
    const response = await handleEnrollmentBulkApprove(
      request({ project_id: PROJECT, enrollment_ids: ids }),
      d,
    );
    expect(((await response.json()) as { results: unknown }).results).toEqual(results);
    expect(calls[0]?.fn).toBe('bulk_approve_enrollments');
    const tooMany = await handleEnrollmentBulkApprove(
      request({ project_id: PROJECT, enrollment_ids: Array.from({ length: 101 }, () => KEY) }),
      deps({ ok: true, data: [] }).d,
    );
    expect(tooMany.status).toBe(422);
    expect(((await tooMany.json()) as { error: { code: string } }).error.code).toBe(
      'TOO_MANY_ENROLLMENTS',
    );
  });
});
