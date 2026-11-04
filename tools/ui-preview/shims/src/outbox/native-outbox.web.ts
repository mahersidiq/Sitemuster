import { ApiError, type SiteMusterApi } from '../api/types';
import { MemoryOutboxTable, OperationalOutbox, type OutboxCipher } from './outbox';

/**
 * WEB RENDER ONLY (tools/ui-preview): the same outbox and the real ingest-operations call against
 * the LOCAL stack, with in-memory rows and no encryption (nothing is stored beyond the page).
 * The native app always uses src/outbox/native-outbox.ts (expo-sqlite + AES-256-GCM).
 */
const table = new MemoryOutboxTable();
const cipher: OutboxCipher = {
  seal: async (_id, plain) => plain,
  open: async (_id, envelope) => envelope,
};

export function createNativeOutbox(api: SiteMusterApi, userId: string): OperationalOutbox {
  return new OperationalOutbox(
    {
      table,
      cipher,
      send: async (request) => {
        try {
          return { ok: true, response: await api.ingestOperations(request) };
        } catch (error) {
          return { ok: false, code: error instanceof ApiError ? error.code : 'NETWORK' };
        }
      },
      now: () => Date.now(),
      newUuid: () => crypto.randomUUID(),
      report: (entry) => console.warn('outbox:', JSON.stringify(entry)),
    },
    userId,
  );
}
