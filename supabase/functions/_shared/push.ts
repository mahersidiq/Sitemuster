import { FakePushProvider } from '../../../packages/shared/src/providers/fakes.ts';
import { selectProvider } from '../../../packages/shared/src/providers/registry.ts';
import type {
  PushMessage,
  PushProvider,
  PushTicket,
} from '../../../packages/shared/src/providers/types.ts';
import type { FunctionEnvironment } from './http.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100;

/**
 * Expo Push Service (the locked push provider). It needs no secret; an optional access token is
 * sent when the owner turns on Expo's "enhanced push security" (EXPO_ACCESS_TOKEN). A ticket only
 * says Expo accepted the message: delivery is never presence evidence (spec 12).
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'ExpoPushProvider';
  readonly kind = 'real' as const;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly accessToken: string | null,
  ) {}

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let start = 0; start < messages.length; start += CHUNK) {
      const chunk = messages.slice(start, start + CHUNK);
      try {
        const response = await this.fetchImpl(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify(
            chunk.map((message) => ({
              to: message.to,
              title: message.title,
              body: message.body,
              data: message.data ?? {},
              ...(message.categoryId ? { categoryId: message.categoryId } : {}),
              ...(message.channelId ? { channelId: message.channelId } : {}),
              priority: message.priority ?? 'default',
              sound: message.sound === undefined ? 'default' : message.sound,
            })),
          ),
        });
        if (!response.ok) {
          tickets.push(
            ...chunk.map((m) => ({
              to: m.to,
              status: 'error' as const,
              error: `HTTP_${response.status}`,
            })),
          );
          continue;
        }
        const body = (await response.json().catch(() => null)) as {
          data?: { status?: string; message?: string; details?: { error?: string } }[];
        } | null;
        chunk.forEach((message, index) => {
          const ticket = body?.data?.[index];
          tickets.push(
            ticket?.status === 'ok'
              ? { to: message.to, status: 'ok' }
              : {
                  to: message.to,
                  status: 'error',
                  error: String(ticket?.details?.error ?? ticket?.message ?? 'NO_TICKET').slice(
                    0,
                    120,
                  ),
                },
          );
        });
      } catch {
        tickets.push(
          ...chunk.map((m) => ({ to: m.to, status: 'error' as const, error: 'NETWORK' })),
        );
      }
    }
    return tickets;
  }
}

/**
 * Staging and production always use Expo; the typed fake (records, sends nothing) exists only in
 * development and tests. There is no fallback from live to fake.
 */
export function pushProviderFor(
  environment: FunctionEnvironment,
  fetchImpl: typeof fetch,
  accessToken: string | null,
): PushProvider {
  return selectProvider<PushProvider>({
    env: environment,
    name: 'ExpoPushProvider',
    real: environment === 'development' ? null : () => new ExpoPushProvider(fetchImpl, accessToken),
    fake: () => new FakePushProvider(environment),
  });
}
