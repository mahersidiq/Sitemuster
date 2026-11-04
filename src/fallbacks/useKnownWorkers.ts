import { useEffect, useRef } from 'react';

import { useOutbox } from '../state/outbox';

/**
 * A worker approved after the kiosk opened (orientation at the gate) is unknown to the cached
 * name list: when an accepted scan names someone not in it, reload the list once per worker.
 */
export function useRefreshForUnknownWorkers(
  known: (workerId: string) => boolean,
  ready: boolean,
  refetch: () => unknown,
): void {
  const { entries } = useOutbox();
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!ready) return;
    const unknown = entries
      .map((entry) => entry.result?.worker_id)
      .filter((id): id is string => typeof id === 'string' && !known(id) && !asked.current.has(id));
    if (unknown.length === 0) return;
    for (const id of unknown) asked.current.add(id);
    void refetch();
  }, [entries, known, ready, refetch]);
}
