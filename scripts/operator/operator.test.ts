import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { commandFor, runOperator, UsageError } from './operator.mts';

const ID = '5d000000-0000-4000-8000-0000000000a1';
const HASH = 'a'.repeat(64);

describe('operator CLI arguments', () => {
  it('maps every command to its audited RPC with the reason', () => {
    expect(commandFor(['health', '--reason', 'weekly review'])).toEqual({
      rpc: 'operator_health',
      args: { p_reason: 'weekly review' },
    });
    expect(commandFor(['org-lookup', 'Gulf', 'Coast', '--reason', 'ticket 42']).args).toEqual({
      p_query: 'Gulf Coast',
      p_reason: 'ticket 42',
    });
    expect(commandFor(['revoke-device', ID, '--reason', 'stolen phone']).rpc).toBe(
      'operator_revoke_device',
    );
    expect(
      commandFor([
        'legal-approve',
        ID,
        '--hash',
        HASH.toUpperCase(),
        '--reviewer-name',
        'Avery Counsel',
        '--reviewer-role',
        'Employment counsel',
        '--reason',
        'signed off',
      ]).args,
    ).toEqual({
      p_notice_id: ID,
      p_content_hash: HASH,
      p_reviewer_name: 'Avery Counsel',
      p_reviewer_role: 'Employment counsel',
      p_review_reference: null,
      p_reason: 'signed off',
    });
    expect(
      commandFor([
        'hold-set',
        ID,
        '--kind',
        'LEGAL_HOLD',
        '--basis',
        'Incident 7',
        '--reason',
        'counsel',
      ]).args,
    ).toMatchObject({ p_organization_id: ID, p_project_id: null, p_kind: 'LEGAL_HOLD' });
    expect(commandFor(['flags', '--reason', 'weekly flag review'])).toEqual({
      rpc: 'operator_list_security_flags',
      args: { p_reason: 'weekly flag review' },
    });
    expect(
      commandFor(['flag-review', ID, '--note', 'load test traffic', '--reason', 'flag review'])
        .args,
    ).toEqual({ p_flag_id: ID, p_note: 'load test traffic', p_reason: 'flag review' });
    expect(() => commandFor(['flag-review', ID, '--reason', 'flag review'])).toThrow(/--note/);
  });

  it('refuses a missing reason, malformed ids, a bad hash, an unknown kind or command', () => {
    expect(() => commandFor(['health'])).toThrow(UsageError);
    expect(() => commandFor(['revoke-device', 'abc', '--reason', 'stolen'])).toThrow(/UUID/);
    expect(() =>
      commandFor([
        'legal-approve',
        ID,
        '--hash',
        'xyz',
        '--reviewer-name',
        'A',
        '--reviewer-role',
        'B',
        '--reason',
        'ok!',
      ]),
    ).toThrow(/SHA-256/);
    expect(() =>
      commandFor(['hold-set', ID, '--kind', 'FOREVER', '--basis', 'x', '--reason', 'why']),
    ).toThrow(/LEGAL_HOLD/);
    expect(() => commandFor(['drop-database', '--reason', 'why not'])).toThrow(/Unknown command/);
    expect(() => commandFor(['health', '--reason'])).toThrow(/needs a value/);
  });
});

/** A fake supabase-js client that records calls. */
function fakeClient(options: { verifiedFactor: boolean }) {
  const calls: string[] = [];
  const client = {
    auth: {
      signInWithOtp: async () => {
        calls.push('signInWithOtp');
        return { error: null };
      },
      verifyOtp: async ({ token }: { token: string }) => {
        calls.push(`verifyOtp:${token}`);
        return { error: null };
      },
      mfa: {
        listFactors: async () => ({
          data: { totp: options.verifiedFactor ? [{ id: 'f1', status: 'verified' }] : [] },
        }),
        challenge: async () => ({ data: { id: 'c1' }, error: null }),
        verify: async ({ code }: { code: string }) => {
          calls.push(`mfa:${code}`);
          return { error: null };
        },
      },
      signOut: async () => {
        calls.push('signOut');
        return { error: null };
      },
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(`rpc:${name}:${String(args.p_reason)}`);
      return { data: { ok: true }, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('operator CLI run', () => {
  it('signs in with the e-mail code and the authenticator, runs one RPC and signs out', async () => {
    const { client, calls } = fakeClient({ verifiedFactor: true });
    const answers = ['123456', '654321'];
    const printed: string[] = [];
    const code = await runOperator(['health', '--reason', 'weekly review'], {
      client,
      email: 'operator@example.test',
      io: { prompt: async () => answers.shift() ?? '', print: (line) => printed.push(line) },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      'signInWithOtp',
      'verifyOtp:123456',
      'mfa:654321',
      'rpc:operator_health:weekly review',
      'signOut',
    ]);
    expect(printed.join('\n')).toContain('"ok": true');
  });

  it('an operator account without an authenticator runs nothing', async () => {
    const { client, calls } = fakeClient({ verifiedFactor: false });
    const printed: string[] = [];
    const code = await runOperator(['health', '--reason', 'weekly review'], {
      client,
      email: 'operator@example.test',
      io: { prompt: async () => '123456', print: (line) => printed.push(line) },
    });
    expect(code).toBe(1);
    expect(calls.some((call) => call.startsWith('rpc:'))).toBe(false);
    expect(printed.join('\n')).toContain('Operators must use MFA');
  });

  it('a usage error never signs in', async () => {
    const { client, calls } = fakeClient({ verifiedFactor: true });
    const code = await runOperator(['health'], {
      client,
      email: 'operator@example.test',
      io: { prompt: async () => '', print: () => undefined },
    });
    expect([code, calls]).toEqual([2, []]);
  });
});
