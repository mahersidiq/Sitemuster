import { useCallback, useEffect, useState } from 'react';

/** UI countdown (seconds) for resend cooldowns. Display only — the server enforces the limit. */
export function useCountdown(initialSeconds: number) {
  const [deadline, setDeadline] = useState(() => Date.now() + Math.max(0, initialSeconds) * 1000);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline <= now) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [deadline, now]);

  const restart = useCallback((seconds: number) => {
    const current = Date.now();
    setNow(current);
    setDeadline(current + Math.max(0, seconds) * 1000);
  }, []);

  return { remaining: Math.max(0, Math.ceil((deadline - now) / 1000)), restart };
}
