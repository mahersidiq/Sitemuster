import { backendEnv } from './env';

interface MailpitSearch {
  messages: { ID: string; Created: string }[];
}

/** Waits for the newest sign-in email to an address and extracts its 6-digit code. */
export async function latestEmailCode(address: string, timeoutMs = 10_000): Promise<string> {
  const { mailpitUrl } = backendEnv();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const search = (await (
      await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)
    ).json()) as MailpitSearch;
    const newest = search.messages[0];
    if (newest) {
      const message = (await (await fetch(`${mailpitUrl}/api/v1/message/${newest.ID}`)).json()) as {
        Text?: string;
        HTML?: string;
      };
      const code = `${message.Text ?? ''} ${message.HTML ?? ''}`.match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no sign-in email received for ${address}`);
}
