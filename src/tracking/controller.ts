import type { Config } from 'react-native-background-geolocation';

import { distanceMeters, ms } from '@sitemuster/shared';

import { egressDecision, type GateFence, type QueuedRecord } from './gate';
import { modeConfig, PERSIST_MODE_GEOFENCE } from './sdk-config';

/**
 * Two-mode tracking controller (docs/spec/03 "Two-mode engine"; decisions #90, #91). Pure: given
 * the persisted state and one event it returns the next state and the SDK commands to run, in
 * order. It runs in the foreground app and in the Android headless task alike.
 *
 * ARMED_OFFSITE    geofence-only, coordinate-free records, the SDK uploads on its own.
 * ENTRY_PENDING    inside a native fence: gated tracking, JS syncs after the egress gate.
 * ONSITE_ESTIMATED two locally qualified fixes ≥ dwell apart (informational; the server decides).
 * TRACKING_LIMITED is ARMED_OFFSITE with coordinates not released: never leaves geofence-only.
 */
export type TrackingMode = 'DISARMED' | 'ARMED_OFFSITE' | 'ENTRY_PENDING' | 'ONSITE_ESTIMATED';

export interface ControllerFence extends GateFence {
  dwellSeconds: number;
  maxAccuracyM: number;
}

export interface ControllerState {
  mode: TrackingMode;
  /** Projects whose native fence reported ENTER with no EXIT since. */
  inside: string[];
  /** Local dwell evidence: timestamps only (no coordinates are ever kept here). */
  qualified: Record<string, string[]>;
  fences: ControllerFence[];
  coordinatesAllowed: boolean;
}

export type Command =
  | { type: 'SET_CONFIG'; config: Partial<Config> }
  | { type: 'REPLACE_FENCES'; fences: ControllerFence[] }
  | { type: 'START_GEOFENCES' }
  | { type: 'START_TRACKING' }
  | { type: 'STOP' }
  | { type: 'CURRENT_POSITION'; persist: boolean }
  /** Read the native queue and destroy everything the egress gate refuses. */
  | { type: 'PRUNE' }
  | { type: 'DESTROY'; uuid: string }
  /** Drop every queued record (signed out, consent withdrawn, phone replaced). */
  | { type: 'CLEAR_QUEUE' }
  | { type: 'SYNC' };

export interface Transition {
  state: ControllerState;
  commands: Command[];
}

export const DISARMED: ControllerState = {
  mode: 'DISARMED',
  inside: [],
  qualified: {},
  fences: [],
  coordinatesAllowed: false,
};

const onsiteMode = (mode: TrackingMode) => mode === 'ENTRY_PENDING' || mode === 'ONSITE_ESTIMATED';

/** Going offsite: stop persisting positions FIRST, prune, and only then let the SDK upload. */
function goOffsite(): Command[] {
  return [
    { type: 'SET_CONFIG', config: { persistence: { persistMode: PERSIST_MODE_GEOFENCE } } },
    { type: 'START_GEOFENCES' },
    { type: 'PRUNE' },
    { type: 'SET_CONFIG', config: modeConfig('OFFSITE') },
    { type: 'SYNC' },
  ];
}

/** Going onsite: autoSync off in the same call that starts persisting positions. */
function goOnsite(): Command[] {
  return [
    { type: 'SET_CONFIG', config: modeConfig('ONSITE') },
    { type: 'START_TRACKING' },
    { type: 'CURRENT_POSITION', persist: true },
    { type: 'PRUNE' },
    { type: 'SYNC' },
  ];
}

const sameFences = (a: readonly ControllerFence[], b: readonly ControllerFence[]) =>
  a.length === b.length &&
  a.every((fence, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      fence.identifier === other.identifier &&
      fence.nativeRadiusM === other.nativeRadiusM &&
      fence.center.lat === other.center.lat &&
      fence.center.lng === other.center.lng
    );
  });

/** (Re-)arm with the monitored fences of the current plan. */
export function arm(
  previous: ControllerState,
  input: { fences: ControllerFence[]; coordinatesAllowed: boolean },
): Transition {
  const ids = new Set(input.fences.map((fence) => fence.projectId));
  const inside = previous.inside.filter((projectId) => ids.has(projectId));
  const qualified = Object.fromEntries(
    Object.entries(previous.qualified).filter(([projectId]) => inside.includes(projectId)),
  );
  const commands: Command[] = [];
  if (!sameFences(previous.fences, input.fences) || previous.mode === 'DISARMED') {
    commands.push({ type: 'REPLACE_FENCES', fences: input.fences });
  }
  const onsite = input.coordinatesAllowed && inside.length > 0;
  const mode: TrackingMode = onsite
    ? previous.mode === 'ONSITE_ESTIMATED'
      ? 'ONSITE_ESTIMATED'
      : 'ENTRY_PENDING'
    : 'ARMED_OFFSITE';
  commands.push(...(onsite ? goOnsite() : goOffsite()));
  return {
    state: {
      mode,
      inside,
      qualified,
      fences: input.fences,
      coordinatesAllowed: input.coordinatesAllowed,
    },
    commands,
  };
}

/** Consent withdrawn, signed out, replaced phone, no bound project: stop and drop the queue. */
export function disarm(): Transition {
  return {
    state: DISARMED,
    commands: [
      { type: 'SET_CONFIG', config: { persistence: { persistMode: PERSIST_MODE_GEOFENCE } } },
      { type: 'STOP' },
      { type: 'REPLACE_FENCES', fences: [] },
      { type: 'CLEAR_QUEUE' },
    ],
  };
}

export function onGeofence(
  state: ControllerState,
  event: { identifier: string; action: 'ENTER' | 'EXIT'; timestamp: string },
): Transition {
  if (state.mode === 'DISARMED') return { state, commands: [] };
  const fence = state.fences.find((candidate) => candidate.identifier === event.identifier);
  if (!fence) return { state, commands: [] }; // unknown/old fence: the server resolves the record
  if (event.action === 'ENTER') {
    if (state.inside.includes(fence.projectId)) return { state, commands: [] };
    const inside = [...state.inside, fence.projectId].sort();
    if (!state.coordinatesAllowed) {
      // TRACKING_LIMITED: coordinate-free ENTER only; the SDK uploads it by itself.
      return { state: { ...state, inside }, commands: [] };
    }
    if (onsiteMode(state.mode)) {
      return { state: { ...state, inside }, commands: [{ type: 'PRUNE' }, { type: 'SYNC' }] };
    }
    return { state: { ...state, inside, mode: 'ENTRY_PENDING' }, commands: goOnsite() };
  }
  const inside = state.inside.filter((projectId) => projectId !== fence.projectId);
  const { [fence.projectId]: _dropped, ...qualified } = state.qualified;
  if (inside.length > 0 || !onsiteMode(state.mode)) {
    return {
      state: { ...state, inside, qualified },
      commands: onsiteMode(state.mode) ? [{ type: 'PRUNE' }, { type: 'SYNC' }] : [],
    };
  }
  return {
    state: { ...state, inside, qualified: {}, mode: 'ARMED_OFFSITE' },
    commands: goOffsite(),
  };
}

/** A location the SDK persisted (onsite): gate it immediately, track local dwell, sync. */
export function onLocation(state: ControllerState, record: QueuedRecord): Transition {
  if (!onsiteMode(state.mode)) {
    // Offsite nothing is persisted; if a stray record exists the gate removes it.
    return egressDecision(record, state.fences, state.coordinatesAllowed) === 'DESTROY'
      ? { state, commands: [{ type: 'DESTROY', uuid: record.uuid }] }
      : { state, commands: [] };
  }
  if (egressDecision(record, state.fences, state.coordinatesAllowed) === 'DESTROY') {
    return { state, commands: [{ type: 'DESTROY', uuid: record.uuid }] };
  }
  let next = state;
  const coords = record.coords;
  if (coords && record.timestamp && record.mock !== true) {
    const point = { lat: coords.latitude, lng: coords.longitude };
    const fence = state.fences.find(
      (candidate) =>
        state.inside.includes(candidate.projectId) &&
        coords.accuracy <= candidate.maxAccuracyM &&
        distanceMeters(point, candidate.center) <= candidate.radiusM,
    );
    if (fence) {
      const stamps = [...(state.qualified[fence.projectId] ?? []), record.timestamp]
        .sort((a, b) => ms(a) - ms(b))
        .slice(-4);
      const first = stamps[0];
      const last = stamps[stamps.length - 1];
      const dwelled =
        first !== undefined &&
        last !== undefined &&
        ms(last) - ms(first) >= fence.dwellSeconds * 1000;
      next = {
        ...state,
        qualified: { ...state.qualified, [fence.projectId]: stamps },
        mode: dwelled ? 'ONSITE_ESTIMATED' : state.mode,
      };
    }
  }
  return { state: next, commands: [{ type: 'PRUNE' }, { type: 'SYNC' }] };
}

/** Heartbeat: onsite ask for a fresh (persisted) fix — stationary 5-minute target; else sync. */
export function onHeartbeat(state: ControllerState): Transition {
  if (state.mode === 'DISARMED') return { state, commands: [] };
  return onsiteMode(state.mode)
    ? { state, commands: [{ type: 'CURRENT_POSITION', persist: true }] }
    : { state, commands: [{ type: 'SYNC' }] };
}
