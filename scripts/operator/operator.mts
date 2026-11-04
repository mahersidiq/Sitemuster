import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * SiteMuster platform operator CLI (docs/spec/09 "Platform operator restrictions", spec 02 column
 * A; decision #129). Private tool, no web UI. The operator signs in as themselves with an e-mail
 * code AND their authenticator (aal2) using only the public anon key — never a service key.
 * Every command needs a --reason; the database checks the operator role, MFA and the reason,
 * rate-limits the calls and records each one in the append-only platform_operator_actions.
 * Nothing here can read coordinates, emergency contacts, roster names or attendance.
 */
export class UsageError extends Error {}

export interface OperatorIo {
  prompt(question: string): Promise<string>;
  print(line: string): void;
}

export interface OperatorCommand {
  rpc: string;
  args: Record<string, unknown>;
}

export const USAGE = `Usage: npm run operator -- <command> [arguments] --reason "<why, 3-500 characters>"

Commands:
  health                                         Non-sensitive counts, queues and job runs
  org-lookup <name or organization id>           Organization metadata and counts (no people)
  revoke-device <device id>                      Stop a lost or stolen phone at once
  resend-invite <invitation id>                  Re-arm a pending in-app invitation for 7 days
  legal-list                                     Legal notice versions and review status
  legal-approve <notice id> --hash <sha256> --reviewer-name "<name>" --reviewer-role "<role>" [--reference "<ref>"]
                                                 Record a human reviewer's approval of that exact text
  legal-retire <notice id>                       Retire a notice version
  hold-set <organization id> --kind LEGAL_HOLD|CONTRACT_RETENTION --basis "<documented basis>" [--project <project id>]
  hold-release <hold id>
  mfa-reset <user id>                            After an out-of-band identity check (never an operator)

Environment: SITEMUSTER_SUPABASE_URL, SITEMUSTER_SUPABASE_ANON_KEY (public values) and
SITEMUSTER_OPERATOR_EMAIL. The e-mail code and authenticator code are asked for each run.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv: readonly string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new UsageError(`${arg} needs a value.`);
      flags[arg.slice(2)] = value;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  const [command = '', ...rest] = positional;
  return { command, positional: rest, flags };
}

function uuid(value: string | undefined, what: string): string {
  if (!value || !UUID.test(value)) throw new UsageError(`${what} must be a UUID.`);
  return value.toLowerCase();
}

function required(value: string | undefined, what: string): string {
  if (!value || value.trim() === '') throw new UsageError(`${what} is required.`);
  return value.trim();
}

/** The RPC a command calls, with its arguments; throws UsageError for anything malformed. */
export function commandFor(argv: readonly string[]): OperatorCommand {
  const { command, positional, flags } = parseArgs(argv);
  if (command === '' || command === 'help') throw new UsageError(USAGE);
  const reason = flags.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 500) {
    throw new UsageError('--reason "<why>" is required (3-500 characters).');
  }
  switch (command) {
    case 'health':
      return { rpc: 'operator_health', args: { p_reason: reason } };
    case 'org-lookup':
      return {
        rpc: 'operator_org_lookup',
        args: {
          p_query: required(positional.join(' '), 'A name or organization id'),
          p_reason: reason,
        },
      };
    case 'revoke-device':
      return {
        rpc: 'operator_revoke_device',
        args: { p_device_id: uuid(positional[0], 'The device id'), p_reason: reason },
      };
    case 'resend-invite':
      return {
        rpc: 'operator_resend_invitation',
        args: { p_invitation_id: uuid(positional[0], 'The invitation id'), p_reason: reason },
      };
    case 'legal-list':
      return { rpc: 'operator_list_legal_notices', args: { p_reason: reason } };
    case 'legal-approve': {
      const hash = required(flags.hash, '--hash').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash))
        throw new UsageError('--hash must be the 64-character SHA-256.');
      return {
        rpc: 'operator_approve_legal_notice',
        args: {
          p_notice_id: uuid(positional[0], 'The notice id'),
          p_content_hash: hash,
          p_reviewer_name: required(flags['reviewer-name'], '--reviewer-name'),
          p_reviewer_role: required(flags['reviewer-role'], '--reviewer-role'),
          p_review_reference: flags.reference?.trim() || null,
          p_reason: reason,
        },
      };
    }
    case 'legal-retire':
      return {
        rpc: 'operator_retire_legal_notice',
        args: { p_notice_id: uuid(positional[0], 'The notice id'), p_reason: reason },
      };
    case 'hold-set': {
      const kind = required(flags.kind, '--kind');
      if (kind !== 'LEGAL_HOLD' && kind !== 'CONTRACT_RETENTION') {
        throw new UsageError('--kind must be LEGAL_HOLD or CONTRACT_RETENTION.');
      }
      return {
        rpc: 'operator_set_retention_hold',
        args: {
          p_organization_id: uuid(positional[0], 'The organization id'),
          p_project_id: flags.project ? uuid(flags.project, '--project') : null,
          p_kind: kind,
          p_basis: required(flags.basis, '--basis'),
          p_reason: reason,
        },
      };
    }
    case 'hold-release':
      return {
        rpc: 'operator_release_retention_hold',
        args: { p_hold_id: uuid(positional[0], 'The hold id'), p_reason: reason },
      };
    case 'mfa-reset':
      return {
        rpc: 'operator_reset_staff_mfa',
        args: { p_user_id: uuid(positional[0], 'The user id'), p_reason: reason },
      };
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

/** E-mail code, then the authenticator (aal2). Refuses an operator account without one. */
export async function signInOperator(
  client: SupabaseClient,
  email: string,
  io: OperatorIo,
): Promise<void> {
  const sent = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (sent.error) throw new Error('Could not send the e-mail code. Try again in a minute.');
  const verified = await client.auth.verifyOtp({
    email,
    token: (await io.prompt('E-mail code: ')).trim(),
    type: 'email',
  });
  if (verified.error) throw new Error('The e-mail code was not accepted.');
  const factors = await client.auth.mfa.listFactors();
  const factor = factors.data?.totp.find((candidate) => candidate.status === 'verified');
  if (!factor) {
    throw new Error('This account has no verified authenticator. Operators must use MFA.');
  }
  const challenge = await client.auth.mfa.challenge({ factorId: factor.id });
  if (challenge.error || !challenge.data)
    throw new Error('Could not start the authenticator check.');
  const mfa = await client.auth.mfa.verify({
    factorId: factor.id,
    challengeId: challenge.data.id,
    code: (await io.prompt('Authenticator code: ')).trim(),
  });
  if (mfa.error) throw new Error('The authenticator code was not accepted.');
}

/** Runs one command; returns the process exit code (0 ok, 1 refused/failed, 2 usage). */
export async function runOperator(
  argv: readonly string[],
  deps: { client: SupabaseClient; email: string; io: OperatorIo },
): Promise<number> {
  let command: OperatorCommand;
  try {
    command = commandFor(argv);
  } catch (error) {
    deps.io.print(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    await signInOperator(deps.client, deps.email, deps.io);
    const { data, error } = await deps.client.rpc(command.rpc, command.args);
    if (error) {
      deps.io.print(`Refused: ${error.message}`);
      return 1;
    }
    deps.io.print(JSON.stringify(data, null, 2));
    return 0;
  } catch (error) {
    deps.io.print(error instanceof Error ? error.message : 'Sign-in failed.');
    return 1;
  } finally {
    await deps.client.auth.signOut();
  }
}
