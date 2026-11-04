import { describe, expect, it } from 'vitest';

import { MusterStartResponseSchema } from '../../../packages/shared/src/api/muster.ts';
import { FakePushProvider } from '../../../packages/shared/src/providers/fakes.ts';
import type { PushProvider } from '../../../packages/shared/src/providers/types.ts';
import {
  type CloseRow,
  handleMusterClose,
  handleMusterStart,
  type MusterDeps,
  MusterRpcError,
  pushTargetsFromJson,
  type StartRow,
} from './muster-core.ts';
import { ExpoPushProvider, pushProviderFor } from './push.ts';

const PROJECT = '0a000000-0000-4000-8000-0000000000a1';
const MUSTER = '9a000000-0000-4000-8000-0000000000a1';
const KEY = 'a0000000-0000-4000-8000-000000000101';
const counts = {
  workers: {
    total: 2,
    verified: 0,
    self_reported: 0,
    unknown: 0,
    unaccounted: 2,
    detected_at_start: 1,
  },
  visitors: { total: 1, verified: 0, unaccounted: 1 },
};

interface World {
  deps: MusterDeps;
  push: FakePushProvider;
  recorded: { member_id: string; status: string; error: string | null }[];
  starts: number;
  denied: boolean;
}

function world(overrides: Partial<MusterDeps> = {}): World {
  const push = new FakePushProvider('test');
  const w = { push, recorded: [], starts: 0, denied: false } as unknown as World;
  w.deps = {
    now: () => Date.parse('2026-11-04T15:00:00Z'),
    requestId: '00000000-0000-4000-8000-000000000001',
    start: async (): Promise<StartRow> => {
      if (w.denied) throw new MusterRpcError(400, 'FORBIDDEN');
      w.starts += 1;
      return {
        muster_id: MUSTER,
        created: w.starts === 1,
        duplicate: false,
        already_active: w.starts > 1,
      };
    },
    close: async ({ acknowledge }): Promise<CloseRow> => {
      if (!acknowledge) throw new MusterRpcError(400, 'ACKNOWLEDGE_INCOMPLETE_REQUIRED');
      return { muster_id: MUSTER, duplicate: false, digest: 'a'.repeat(64), counts };
    },
    pushTargets: async () => [
      { memberId: 'm1', token: 'ExponentPushToken[aaaaaaaaaa]', locale: 'en-US' },
      { memberId: 'm2', token: 'ExponentPushToken[bbbbbbbbbb]', locale: 'es-US' },
    ],
    recordPush: async (_muster, results) => {
      w.recorded.push(...results);
    },
    push,
    ...overrides,
  };
  return w;
}

async function call(
  handler: typeof handleMusterStart,
  deps: MusterDeps,
  body: unknown,
  token: string | null = 'Bearer jwt',
) {
  const response = await handler(
    new Request('https://x.test/functions/v1/muster', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
      body: JSON.stringify(body),
    }),
    deps,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const start = (extra: Record<string, unknown> = {}) => ({
  schema_version: 1,
  project_id: PROJECT,
  incident_label: 'Fire alarm',
  idempotency_key: KEY,
  ...extra,
});

describe('muster-start', () => {
  it('starts once, alerts every registered phone in its language, and records each outcome', async () => {
    const w = world();
    const first = await call(handleMusterStart, w.deps, start());
    expect(first.status).toBe(200);
    expect(MusterStartResponseSchema.parse(first.body)).toMatchObject({
      created: true,
      push: { provider: 'development-fake', targets: 2, sent: 2, failed: 0 },
    });
    expect(w.push.sent.map((m) => [m.title, m.categoryId, m.priority])).toEqual([
      ["Emergency muster — tap I'M SAFE", 'MUSTER', 'high'],
      ['Reunión de emergencia — toque ESTOY A SALVO', 'MUSTER', 'high'],
    ]);
    expect(w.push.sent[0]?.data).toEqual({ type: 'MUSTER', muster_id: MUSTER, member_id: 'm1' });
    expect(w.recorded.map((r) => r.status)).toEqual(['ok', 'ok']);
    // A second tap joins the same muster and sends nothing again.
    const second = await call(handleMusterStart, w.deps, start());
    expect(second.body).toMatchObject({ created: false, already_active: true, push: null });
    expect(w.push.sent).toHaveLength(2);
  });

  it('a push outage never blocks or fails the muster (spec 07 "Push provider fails")', async () => {
    const w = world();
    w.push.outage = true;
    const out = await call(handleMusterStart, w.deps, start());
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ created: true, push: { sent: 0, failed: 2 } });
    expect(w.recorded.map((r) => r.status)).toEqual(['error', 'error']);
    const broken = world({
      pushTargets: async () => {
        throw new Error('database unavailable');
      },
    });
    const still = await call(handleMusterStart, broken.deps, start());
    expect([still.status, still.body.created]).toEqual([200, true]);
  });

  it('refuses callers without the safety role, a missing label and an anonymous call', async () => {
    const w = world();
    w.denied = true;
    const denied = await call(handleMusterStart, w.deps, start());
    expect([denied.status, (denied.body.error as { code: string }).code]).toEqual([
      403,
      'FORBIDDEN',
    ]);
    const noLabel = await call(handleMusterStart, world().deps, start({ incident_label: '  ' }));
    expect([noLabel.status, (noLabel.body.error as { code: string }).code]).toEqual([
      422,
      'LABEL_REQUIRED',
    ]);
    expect((await call(handleMusterStart, world().deps, start(), null)).status).toBe(401);
  });
});

describe('muster-close', () => {
  const close = (extra: Record<string, unknown> = {}) => ({
    schema_version: 1,
    muster_id: MUSTER,
    closure_note: 'All accounted except two',
    acknowledge_incomplete: true,
    ...extra,
  });

  it('closes with a note and returns the report digest and counts', async () => {
    const out = await call(handleMusterClose, world().deps, close());
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      muster_id: MUSTER,
      duplicate: false,
      digest: 'a'.repeat(64),
      counts,
    });
  });

  it('unresolved people need an explicit acknowledgement; a note is required', async () => {
    const ack = await call(
      handleMusterClose,
      world().deps,
      close({ acknowledge_incomplete: false }),
    );
    expect([ack.status, (ack.body.error as { code: string }).code]).toEqual([
      422,
      'ACKNOWLEDGE_INCOMPLETE_REQUIRED',
    ]);
    const note = await call(handleMusterClose, world().deps, close({ closure_note: 'ok' }));
    expect([note.status, (note.body.error as { code: string }).code]).toEqual([
      422,
      'REASON_REQUIRED',
    ]);
  });
});

describe('push adapters', () => {
  it('Expo: chunks of 100, per-message tickets, the optional access token, errors as failures', async () => {
    const calls: {
      headers: Record<string, string>;
      body: { to: string; categoryId?: string }[];
    }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { to: string }[];
      calls.push({ headers: init.headers as Record<string, string>, body });
      return new Response(
        JSON.stringify({
          data: body.map((m, i) =>
            i === 0 && calls.length === 1
              ? {
                  status: 'error',
                  message: 'not registered',
                  details: { error: 'DeviceNotRegistered' },
                }
              : { status: 'ok', id: m.to },
          ),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = new ExpoPushProvider(fetchImpl, 'secret-token');
    const messages = Array.from({ length: 150 }, (_, i) => ({
      to: `ExponentPushToken[t${i}]`,
      title: 't',
      body: 'b',
      categoryId: 'MUSTER',
    }));
    const tickets = await provider.send(messages);
    expect(calls.map((c) => c.body.length)).toEqual([100, 50]);
    expect(calls[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(calls[0]?.body[0]?.categoryId).toBe('MUSTER');
    expect(tickets.filter((t) => t.status === 'error')).toEqual([
      { to: 'ExponentPushToken[t0]', status: 'error', error: 'DeviceNotRegistered' },
    ]);
    const down = new ExpoPushProvider(
      (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
      null,
    );
    expect((await down.send(messages.slice(0, 2))).map((t) => t.error)).toEqual([
      'NETWORK',
      'NETWORK',
    ]);
  });

  it('staging and production always use Expo; the fake exists only in development', () => {
    const noop = (async () => new Response('{}')) as unknown as typeof fetch;
    expect(pushProviderFor('production', noop, null).kind).toBe('real');
    expect(pushProviderFor('staging', noop, null).kind).toBe('real');
    const dev: PushProvider = pushProviderFor('development', noop, null);
    expect(dev.kind).toBe('fake');
  });

  it('push targets: only rows with a token, unknown languages fall back to English', () => {
    expect(
      pushTargetsFromJson([
        { member_id: 'm1', token: 'ExponentPushToken[x]', locale: 'es-US' },
        { member_id: 'm2', token: 'ExponentPushToken[y]', locale: 'fr-FR' },
        { member_id: 'm3' },
      ]),
    ).toEqual([
      { memberId: 'm1', token: 'ExponentPushToken[x]', locale: 'es-US' },
      { memberId: 'm2', token: 'ExponentPushToken[y]', locale: 'en-US' },
    ]);
  });
});
