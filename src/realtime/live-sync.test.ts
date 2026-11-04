import { describe, expect, it } from 'vitest';

import type { BroadcastMessage } from '@sitemuster/shared';

import type { ProjectChannelListener } from '../api/types';
import {
  ProjectLiveSync,
  REFRESH_WINDOW_MS,
  RESUBSCRIBE_DELAYS_MS,
  type LiveState,
  type RefreshScope,
} from './live-sync';

const PROJECT = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'b0000000-0000-4000-8000-000000000002';

/** A fake clock, timers and channel: deterministic, no real time passes. */
function harness() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 0;
  const refreshes: RefreshScope[][] = [];
  const states: LiveState[] = [];
  const channels: { listener: ProjectChannelListener; closed: boolean }[] = [];
  const sync = new ProjectLiveSync(PROJECT, {
    subscribe: (_projectId, listener) => {
      const channel = { listener, closed: false };
      channels.push(channel);
      return () => {
        channel.closed = true;
      };
    },
    refresh: (scopes) => refreshes.push([...scopes].sort()),
    now: () => now,
    setTimer: (fn, ms) => {
      nextId += 1;
      timers.push({ at: now + ms, fn, id: nextId });
      return nextId;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((t) => t.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  sync.onState((state) => states.push(state));
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
  const channel = () => channels.at(-1) as { listener: ProjectChannelListener; closed: boolean };
  return { sync, refreshes, states, channels, channel, advance };
}

let version = 0;
const message = (
  type: BroadcastMessage['type'] = 'WORKFORCE_CHANGED',
  overrides: Partial<BroadcastMessage> = {},
): BroadcastMessage => {
  version += 1;
  return {
    schema_version: 1,
    type,
    project_id: PROJECT,
    aggregate_version: version,
    counts: { estimated_onsite: 3 },
    changed_ids: [],
    occurred_at: '2026-11-04T12:00:00Z',
    ...overrides,
  };
};

describe('ProjectLiveSync', () => {
  it('joining refetches everything, then each message refetches what it names', () => {
    const h = harness();
    h.sync.start();
    expect(h.states).toEqual(['CONNECTING']);
    h.channel().listener.onStatus('SUBSCRIBED');
    expect(h.states).toEqual(['CONNECTING', 'LIVE']);
    expect(h.refreshes).toEqual([['ALL']]);
    h.advance(REFRESH_WINDOW_MS);
    h.channel().listener.onMessage(message('ENROLLMENT_CHANGED'));
    expect(h.refreshes.at(-1)).toEqual(['ENROLLMENT_CHANGED']);
  });

  it('a burst of messages becomes one refetch now and one at the end of the window', () => {
    const h = harness();
    h.sync.start();
    h.channel().listener.onStatus('SUBSCRIBED');
    h.advance(REFRESH_WINDOW_MS);
    for (let i = 0; i < 25; i += 1) h.channel().listener.onMessage(message());
    h.channel().listener.onMessage(message('PROJECT_CONFIG_CHANGED'));
    expect(h.refreshes).toEqual([['ALL'], ['WORKFORCE_CHANGED']]);
    h.advance(REFRESH_WINDOW_MS);
    expect(h.refreshes).toEqual([
      ['ALL'],
      ['WORKFORCE_CHANGED'],
      ['PROJECT_CONFIG_CHANGED', 'WORKFORCE_CHANGED'],
    ]);
  });

  it('ignores duplicate or out-of-order versions and other projects', () => {
    const h = harness();
    h.sync.start();
    h.channel().listener.onStatus('SUBSCRIBED');
    h.advance(REFRESH_WINDOW_MS);
    const newer = message();
    const older = { ...newer, aggregate_version: newer.aggregate_version - 1 };
    h.channel().listener.onMessage(newer);
    h.advance(REFRESH_WINDOW_MS);
    h.channel().listener.onMessage(newer);
    h.channel().listener.onMessage(older);
    h.channel().listener.onMessage(message('WORKFORCE_CHANGED', { project_id: OTHER }));
    h.advance(REFRESH_WINDOW_MS);
    expect(h.refreshes).toEqual([['ALL'], ['WORKFORCE_CHANGED']]);
  });

  it('a dropped channel pauses, joins again with back-off, and the rejoin resyncs everything', () => {
    const h = harness();
    h.sync.start();
    h.channel().listener.onStatus('SUBSCRIBED');
    h.advance(REFRESH_WINDOW_MS);
    h.channel().listener.onStatus('DISCONNECTED');
    expect(h.sync.status).toBe('PAUSED');
    expect(h.channels).toHaveLength(1);
    h.advance(RESUBSCRIBE_DELAYS_MS[0]);
    expect(h.channels).toHaveLength(2); // a fresh join
    expect(h.channels[0]?.closed).toBe(true);
    h.channel().listener.onStatus('DISCONNECTED'); // still offline
    h.advance(RESUBSCRIBE_DELAYS_MS[0]);
    expect(h.channels).toHaveLength(2); // the second delay is longer
    h.advance(RESUBSCRIBE_DELAYS_MS[1] - RESUBSCRIBE_DELAYS_MS[0]);
    expect(h.channels).toHaveLength(3);
    h.channel().listener.onStatus('SUBSCRIBED');
    expect(h.sync.status).toBe('LIVE');
    expect(h.refreshes).toEqual([['ALL'], ['ALL']]); // missed messages: refetch everything
  });

  it('the socket coming back by itself (realtime-js rejoin) cancels the pending re-join', () => {
    const h = harness();
    h.sync.start();
    h.channel().listener.onStatus('SUBSCRIBED');
    h.channel().listener.onStatus('DISCONNECTED');
    h.channel().listener.onStatus('SUBSCRIBED');
    h.advance(RESUBSCRIBE_DELAYS_MS[3]);
    expect(h.channels).toHaveLength(1);
    expect(h.sync.status).toBe('LIVE');
  });

  it('a refused join (access removed) stops for good and refetches so screens hide the data', () => {
    const h = harness();
    h.sync.start();
    h.channel().listener.onStatus('SUBSCRIBED');
    h.advance(REFRESH_WINDOW_MS);
    h.channel().listener.onStatus('DENIED');
    expect(h.sync.status).toBe('DENIED');
    expect(h.channel().closed).toBe(true);
    expect(h.refreshes.at(-1)).toEqual(['ALL']);
    h.channel().listener.onMessage(message());
    h.channel().listener.onStatus('SUBSCRIBED');
    h.advance(RESUBSCRIBE_DELAYS_MS[3]);
    expect(h.sync.status).toBe('DENIED');
    expect(h.channels).toHaveLength(1);
    expect(h.refreshes).toEqual([['ALL'], ['ALL']]);
  });

  it('resync (foreground, fallback minute) refetches everything; stop silences it', () => {
    const h = harness();
    h.sync.start();
    h.sync.resync();
    expect(h.refreshes).toEqual([['ALL']]);
    h.sync.stop();
    expect(h.channel().closed).toBe(true);
    h.sync.resync();
    h.channel().listener.onStatus('SUBSCRIBED');
    h.advance(REFRESH_WINDOW_MS);
    expect(h.refreshes).toEqual([['ALL']]);
  });
});
