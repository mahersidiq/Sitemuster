import { useEffect, useState } from 'react';

/**
 * Re-renders every `intervalMs` with the current time — used only to rotate on-screen codes and
 * countdowns (never to poll location; banned pattern).
 */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}
