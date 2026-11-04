import { describe, expect, it, jest } from '@jest/globals';

import type { SiteMusterApi } from '../api/types';
import type { OperationDraft, OutboxLabel } from './outbox';

/**
 * Regression for the review finding on PR #8: on a fresh installation two overlapping enqueues
 * (a double tap, two quick scans) must share ONE outbox key. Before the fix each created its own
 * key, only the last one survived in the keystore, and the other entry was later deleted as
 * unreadable — an unsent attendance operation lost without anyone seeing it.
 */
const PROJECT = 'a0000000-0000-4000-8000-000000000001';
const KIOSK = 'c0000000-0000-4000-8000-000000000001';
const LABEL: OutboxLabel = { title: 'Printed badge', badge: 'PRINTED' };

const draft = (n: number): OperationDraft => ({
  project_id: PROJECT,
  operation_type: 'KIOSK_ENTRY',
  observed_at: new Date(Date.UTC(2026, 10, 4, 7, n)).toISOString(),
  payload: {
    badge_payload: `SMP1.printed-badge-code-${n}-abcdefghij`,
    badge_kind: 'PRINTED',
    kiosk_device_id: KIOSK,
    direction: 'ENTRY',
  },
});

/**
 * Fresh copies of the module and of the keystore double it uses: no key in memory, as on the
 * first launch after installing (the setup file empties the keystore before every test).
 */
function freshInstall() {
  let outboxModule: typeof import('./native-outbox') | undefined;
  let secureStore: typeof import('expo-secure-store') | undefined;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    outboxModule = require('./native-outbox') as typeof import('./native-outbox');
    secureStore = require('expo-secure-store') as typeof import('expo-secure-store');
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  if (!outboxModule || !secureStore) throw new Error('modules did not load');
  return { createNativeOutbox: outboxModule.createNativeOutbox, secureStore };
}

const api = {
  ingestOperations: jest.fn(async () => {
    throw new Error('not sent in this test');
  }),
} as unknown as SiteMusterApi;

describe('native operational outbox key', () => {
  it('two overlapping first enqueues share one key: both entries stay readable', async () => {
    const { createNativeOutbox, secureStore } = freshInstall();
    const outbox = createNativeOutbox(api, 'user-1');
    await Promise.all([outbox.enqueue(draft(1), LABEL), outbox.enqueue(draft(2), LABEL)]);

    const entries = await outbox.entries();
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.status === 'PENDING')).toBe(true);
    // Exactly one key was ever written to the keystore.
    expect(jest.mocked(secureStore.setItemAsync)).toHaveBeenCalledTimes(1);
  });

  it('outboxes of different people on one phone share the installation key', async () => {
    const { createNativeOutbox, secureStore } = freshInstall();
    const first = createNativeOutbox(api, 'user-1');
    const second = createNativeOutbox(api, 'user-2');
    await Promise.all([first.enqueue(draft(3), LABEL), second.enqueue(draft(4), LABEL)]);

    expect(await first.entries()).toHaveLength(1);
    expect(await second.entries()).toHaveLength(1);
    expect(jest.mocked(secureStore.setItemAsync)).toHaveBeenCalledTimes(1);
  });
});
