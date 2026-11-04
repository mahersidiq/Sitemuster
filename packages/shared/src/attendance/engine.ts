import type { AttendanceSource, PresenceState } from '../enums.ts';
import { configAt, deriveUuid } from './config.ts';
import { classifyZone, isImplausibleJump } from './geo.ts';
import { scheduleFor } from './schedule.ts';
import { HOUR, iso, maxIso, ms, SECOND } from './time.ts';
import type {
  AttendanceConfig,
  AttendanceEventRow,
  Confidence,
  CorrectionRow,
  EngineContext,
  EngineOutput,
  Evidence,
  ItemResult,
  PositionEffect,
  Qualification,
  ReceiptRow,
  SessionRecord,
  TrackState,
  Verification,
} from './types.ts';

/**
 * Pure attendance state machine (docs/spec/04; decisions #78–#86). One call processes a batch of
 * server-normalized evidence for ONE worker on ONE project, in observed-time order, then applies
 * the time rules up to `now`. It never reads clocks, randomness or I/O, so the replay harness and
 * the Edge Functions run exactly the same rules; the database commit only enforces invariants.
 */

const MAX_GAPS = 200;
type GpsEvidence = Extract<Evidence, { kind: 'GEOFENCE' | 'FIX' | 'MONITORING' }>;

export function emptyTrack(
  projectId: string,
  workerId: string,
  configVersionId: string,
): TrackState {
  return {
    projectId,
    workerId,
    revision: 0,
    presence: 'OFFSITE',
    presenceChangedAt: null,
    confidence: 'LOW',
    monitoring: 'ACTIVE',
    candidate: null,
    lastSeenAt: null,
    lastConfirmedInsideAt: null,
    arrivalConfirmedAt: null,
    evaluatedAt: null,
    presenceCloseoutAt: null,
    requireEnterAfter: null,
    continuityBreakAt: null,
    flags: [],
    configVersionId,
    current: null,
    previous: null,
  };
}

function cloneSession(session: SessionRecord | null): SessionRecord | null {
  return session
    ? {
        ...session,
        gaps: session.gaps.map((g) => ({ ...g })),
        reviewReasons: [...session.reviewReasons],
      }
    : null;
}

function cloneTrack(state: TrackState): TrackState {
  return {
    ...state,
    candidate: state.candidate ? { ...state.candidate } : null,
    flags: [...state.flags],
    current: cloneSession(state.current),
    previous: cloneSession(state.previous),
  };
}

type ActiveSession = SessionRecord & { status: 'OPEN' | 'PENDING_APPROVAL' };

function isActive(session: SessionRecord | null): session is ActiveSession {
  return session !== null && (session.status === 'OPEN' || session.status === 'PENDING_APPROVAL');
}

function isGps(item: Evidence): item is GpsEvidence {
  return item.kind === 'GEOFENCE' || item.kind === 'FIX' || item.kind === 'MONITORING';
}

function witnessedConfidence(item: Extract<Evidence, { kind: 'WITNESSED' }>): Confidence {
  if (item.source === 'KIOSK_DYNAMIC_BADGE') return 'HIGH';
  if (item.source === 'KIOSK_PRINTED_BADGE') return 'LOW';
  return item.method === 'PHYSICAL_CONFIRMATION' ? 'HIGH' : 'MEDIUM';
}

class Machine {
  readonly s: TrackState;
  private readonly touched = new Map<string, SessionRecord>();
  private readonly events: AttendanceEventRow[] = [];
  private readonly receipts: ReceiptRow[] = [];
  private readonly corrections: CorrectionRow[] = [];
  private position: PositionEffect | null = null;
  private readonly seen = new Set<string>();
  private lastFix: { lat: number; lng: number; accuracyM: number; at: number } | null;
  private now = 0;

  constructor(
    state: TrackState,
    private readonly ctx: EngineContext,
  ) {
    this.s = cloneTrack(state);
    this.lastFix = ctx.lastPosition
      ? { ...ctx.lastPosition, at: ms(ctx.lastPosition.observedAt) }
      : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private cfg(id: string): AttendanceConfig {
    const config = this.ctx.configs.get(id);
    if (!config) throw new Error(`configuration version ${id} not loaded`);
    return config;
  }

  private cfgAt(t: number): AttendanceConfig {
    const config = configAt(this.ctx.configs.values(), iso(t));
    if (!config) throw new Error('project has no configuration version');
    return config;
  }

  private unknownMs(config: AttendanceConfig): number {
    return config.presenceUnknownSeconds * SECOND;
  }

  private flag(name: string): void {
    if (!this.s.flags.includes(name)) this.s.flags.push(name);
  }

  private touch(session: SessionRecord): void {
    this.touched.set(session.id, session);
  }

  private setPresence(next: PresenceState, at: number): void {
    if (this.s.presence !== next) {
      this.s.presence = next;
      this.s.presenceChangedAt = iso(at);
    }
  }

  private clearPosition(): void {
    this.position = { op: 'clear' };
  }

  private setPosition(item: Extract<Evidence, { kind: 'FIX' }>, config: AttendanceConfig): void {
    const observed = ms(item.observedAt);
    const expiry = observed + this.unknownMs(config);
    if (expiry <= this.now) return;
    if (this.position?.op === 'set' && ms(this.position.observedAt) > observed) return;
    this.position = {
      op: 'set',
      lat: item.lat,
      lng: item.lng,
      accuracyM: item.accuracyM,
      observedAt: item.observedAt,
      expiryAt: iso(expiry),
    };
  }

  private result(
    item: Evidence,
    status: ItemResult['status'],
    reason: string | null,
    review = false,
  ): ItemResult {
    return { eventUuid: item.eventUuid, status, reason, review };
  }

  private receipt(
    item: GpsEvidence,
    fields: {
      configVersionId: string | null;
      qualification: Qualification;
      terminal: 'accepted' | 'rejected';
      reason: string | null;
    },
  ): void {
    this.receipts.push({
      event_uuid: item.eventUuid,
      device_id: item.deviceId,
      worker_id: item.workerId,
      project_id: item.projectId,
      config_version_id: fields.configVersionId,
      event_type:
        item.kind === 'GEOFENCE'
          ? item.action === 'ENTER'
            ? 'GEOFENCE_ENTER'
            : 'GEOFENCE_EXIT'
          : item.kind === 'FIX'
            ? 'ONSITE_FIX'
            : 'OTHER',
      observed_at: item.observedAt,
      server_received_at: item.receivedAt,
      accuracy_m: item.kind === 'MONITORING' ? null : item.accuracyM,
      qualification_state: fields.qualification,
      terminal_result: fields.terminal,
      rejection_reason: fields.terminal === 'rejected' ? fields.reason : null,
    });
  }

  private event(
    item: Evidence,
    fields: {
      sessionId: string | null;
      source: AttendanceSource;
      direction: AttendanceEventRow['direction'];
      verification: Verification;
      confidence: Confidence;
      reason: string | null;
      configVersionId: string;
      observedAt?: string;
      eventUuid?: string;
    },
  ): void {
    this.events.push({
      event_uuid: fields.eventUuid ?? item.eventUuid,
      worker_id: item.workerId,
      project_id: item.projectId,
      session_id: fields.sessionId,
      actor_id:
        item.kind === 'WITNESSED' || item.kind === 'MANUAL' || item.kind === 'APPROVE_UNSCHEDULED'
          ? item.actorId
          : null,
      kiosk_device_id: item.kind === 'WITNESSED' ? item.kioskDeviceId : null,
      device_id: item.kind === 'GEOFENCE' || item.kind === 'FIX' ? item.deviceId : null,
      config_version_id: fields.configVersionId,
      source: fields.source,
      direction: fields.direction,
      observed_at: fields.observedAt ?? item.observedAt,
      received_at: item.receivedAt,
      verification_status: fields.verification,
      confidence: fields.confidence,
      reason: fields.reason,
    });
  }

  private configForGps(item: GpsEvidence): string | null {
    if (item.kind === 'GEOFENCE') return item.configVersionId;
    return this.cfgAt(ms(item.observedAt)).configVersionId;
  }

  // ---------------------------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------------------------

  private addGap(session: SessionRecord, from: number, to: number): void {
    if (to <= from) return;
    session.gaps.push({ from: iso(from), to: iso(to) });
    session.gaps.sort((a, b) => ms(a.from) - ms(b.from));
    const merged: SessionRecord['gaps'] = [];
    for (const gap of session.gaps) {
      const last = merged[merged.length - 1];
      if (last && ms(gap.from) <= ms(last.to)) {
        last.to = maxIso(last.to, gap.to) ?? last.to;
      } else {
        merged.push({ ...gap });
      }
    }
    while (merged.length > MAX_GAPS) {
      const [first, second] = merged;
      if (!first || !second) break;
      merged.splice(0, 2, { from: first.from, to: second.to });
    }
    session.gaps = merged;
  }

  /** Late evidence inside a recorded gap shortens it; pieces shorter than the threshold vanish. */
  private splitGap(session: SessionRecord, t: number, minimum: number): void {
    const next: SessionRecord['gaps'] = [];
    for (const gap of session.gaps) {
      const from = ms(gap.from);
      const to = ms(gap.to);
      if (t > from && t < to) {
        if (t - from >= minimum) next.push({ from: gap.from, to: iso(t) });
        if (to - t >= minimum) next.push({ from: iso(t), to: gap.to });
      } else {
        next.push(gap);
      }
    }
    session.gaps = next;
  }

  /** Presence evidence for an active session (fix, ENTER or witnessed entry). */
  private evidenceForSession(session: SessionRecord, t: number, qualified: boolean): void {
    const config = this.cfg(session.configVersionId);
    const last = ms(session.lastSeenAt);
    if (t > last) {
      const restart = this.s.continuityBreakAt ? ms(this.s.continuityBreakAt) : null;
      const brokeContinuity = restart !== null && restart > last && restart <= t;
      if (t - last >= this.unknownMs(config) || brokeContinuity) this.addGap(session, last, t);
      session.lastSeenAt = iso(t);
      if (restart !== null && restart <= t) this.s.continuityBreakAt = null;
    } else if (t < last) {
      this.splitGap(session, t, this.unknownMs(config));
    }
    if (qualified && (!session.lastConfirmedInsideAt || t > ms(session.lastConfirmedInsideAt))) {
      session.lastConfirmedInsideAt = iso(t);
    }
    this.s.lastSeenAt = maxIso(this.s.lastSeenAt, iso(t));
    if (qualified) this.s.lastConfirmedInsideAt = maxIso(this.s.lastConfirmedInsideAt, iso(t));
    this.touch(session);
  }

  /** The instant after which evidence no longer belongs to an UNRESOLVED session. */
  private horizon(session: SessionRecord): number {
    if (session.endLatestAt) return ms(session.endLatestAt);
    return session.unresolvedAt ? ms(session.unresolvedAt) : ms(session.lastSeenAt);
  }

  /** Late evidence for an UNRESOLVED session (observed before it was resolved as unknown). */
  private corroborateUnresolved(session: SessionRecord, t: number, qualified: boolean): void {
    if (t < ms(session.startAt)) return;
    const config = this.cfg(session.configVersionId);
    if (t > ms(session.lastSeenAt)) {
      if (t - ms(session.lastSeenAt) >= this.unknownMs(config)) {
        this.addGap(session, ms(session.lastSeenAt), t);
      }
      session.lastSeenAt = iso(t);
    }
    if (qualified) {
      if (!session.lastConfirmedInsideAt || t > ms(session.lastConfirmedInsideAt)) {
        session.lastConfirmedInsideAt = iso(t);
      }
      const latest = session.endLatestAt ? ms(session.endLatestAt) : Number.POSITIVE_INFINITY;
      if ((!session.endEarliestAt || t > ms(session.endEarliestAt)) && t <= latest) {
        session.endEarliestAt = iso(t);
      }
    }
    this.s.lastSeenAt = maxIso(this.s.lastSeenAt, iso(t));
    if (qualified) this.s.lastConfirmedInsideAt = maxIso(this.s.lastConfirmedInsideAt, iso(t));
    this.touch(session);
    // The close-out decision was made without this delayed evidence: undo it when the evidence
    // shows the worker was not stale at that moment (same result as on-time delivery).
    if (
      session.endLatestAt === null &&
      session.unresolvedAt !== null &&
      session.reviewReasons.length === 1 &&
      session.reviewReasons[0] === 'CLOSEOUT_STALE' &&
      ms(session.lastSeenAt) + this.unknownMs(config) > ms(session.unresolvedAt)
    ) {
      session.status =
        session.unscheduled && !session.overtimeApprovedAt && session.unscheduledUntil === null
          ? 'PENDING_APPROVAL'
          : 'OPEN';
      session.unresolvedAt = null;
      session.endEarliestAt = null;
      session.reviewReasons = [];
    }
  }

  private markUnresolved(session: SessionRecord, at: number, reason: string): void {
    session.status = 'UNRESOLVED';
    session.unresolvedAt = iso(at);
    session.endEarliestAt = session.lastConfirmedInsideAt ?? session.startAt;
    if (ms(session.endEarliestAt) < ms(session.startAt)) session.endEarliestAt = session.startAt;
    if (!session.reviewReasons.includes(reason)) session.reviewReasons.push(reason);
    this.touch(session);
    this.setPresence('UNRESOLVED', at);
    this.clearPosition();
  }

  private closeSession(
    session: SessionRecord,
    t: number,
    source: AttendanceSource,
    item: Evidence,
    verification: Verification,
    confidence: Confidence,
  ): void {
    session.status = 'CLOSED';
    session.endAt = iso(t);
    session.endSource = source;
    session.endEarliestAt = null;
    session.endLatestAt = null;
    session.unresolvedAt = null;
    this.touch(session);
    this.event(item, {
      sessionId: session.id,
      source,
      direction: 'EXIT',
      verification,
      confidence,
      reason: null,
      configVersionId: session.configVersionId,
    });
    this.s.previous = session;
    this.s.current = null;
    this.s.candidate = null;
    this.s.continuityBreakAt = null;
    this.s.presenceCloseoutAt = null;
    this.setPresence('OFFSITE', t);
    this.clearPosition();
  }

  /** EXIT without a definite time: keep [last confirmed inside, exit observed] (docs/spec/04). */
  private departurePending(
    session: SessionRecord,
    t: number,
    item: Evidence,
    reason: string,
  ): void {
    session.status = 'UNRESOLVED';
    session.unresolvedAt = iso(t);
    session.endEarliestAt = session.lastConfirmedInsideAt ?? session.startAt;
    session.endLatestAt = iso(t);
    if (!session.reviewReasons.includes(reason)) session.reviewReasons.push(reason);
    this.touch(session);
    this.event(item, {
      sessionId: session.id,
      source: 'GEOFENCE',
      direction: 'EXIT',
      verification: 'REVIEW_REQUIRED',
      confidence: 'LOW',
      reason,
      configVersionId: session.configVersionId,
    });
    this.s.candidate = null;
    this.setPresence('DEPARTURE_PENDING', t);
    this.clearPosition();
  }

  /** A new session cannot start while an UNRESOLVED one is open: bound it first (decision #79). */
  private endUnverifiedBefore(start: number): boolean {
    const old = this.s.current;
    if (!old || old.status !== 'UNRESOLVED') return true;
    const earliest = ms(old.endEarliestAt ?? old.lastConfirmedInsideAt ?? old.startAt);
    if (start <= earliest || start <= ms(old.startAt)) {
      this.flag('OVERLAPPING_EVIDENCE');
      return false;
    }
    const latest = old.endLatestAt ? Math.min(ms(old.endLatestAt), start) : start;
    old.status = 'ENDED_UNVERIFIED';
    old.endEarliestAt = iso(Math.min(earliest, latest));
    old.endLatestAt = iso(latest);
    this.touch(old);
    this.s.previous = old;
    this.s.current = null;
    return true;
  }

  private openSession(fields: {
    id: string;
    start: number;
    lastSeen: number;
    source: AttendanceSource;
    confidence: Confidence;
    config: AttendanceConfig;
    witnessed: boolean;
    openedByEvent: string;
    authorized: boolean;
    approvedBy?: string;
  }): SessionRecord {
    const schedule = scheduleFor(fields.start, fields.config, this.ctx.project.timezone);
    const scheduled = schedule.scheduled;
    const session: SessionRecord = {
      id: fields.id,
      projectId: this.s.projectId,
      workerId: this.s.workerId,
      status: scheduled || fields.authorized ? 'OPEN' : 'PENDING_APPROVAL',
      startAt: iso(fields.start),
      startSource: fields.source,
      startConfidence: fields.confidence,
      endAt: null,
      endSource: null,
      endEarliestAt: null,
      endLatestAt: null,
      configVersionId: fields.config.configVersionId,
      timezone: this.ctx.project.timezone,
      lastSeenAt: iso(fields.lastSeen),
      lastConfirmedInsideAt: iso(fields.lastSeen),
      closeoutAt: iso(schedule.closeoutAt),
      authorizeAt:
        scheduled || fields.authorized || schedule.authorizeAt === null
          ? null
          : iso(schedule.authorizeAt),
      authorizedCloseoutAt:
        scheduled || fields.authorized || schedule.authorizedCloseoutAt === null
          ? null
          : iso(schedule.authorizedCloseoutAt),
      windowStartAt: schedule.windowStart === null ? null : iso(schedule.windowStart),
      windowEndAt: schedule.windowEnd === null ? null : iso(schedule.windowEnd),
      unscheduled: !scheduled,
      unscheduledUntil: null,
      overtimeApprovedAt: !scheduled && fields.authorized ? iso(fields.start) : null,
      overtimeApprovedBy: !scheduled && fields.authorized ? (fields.approvedBy ?? null) : null,
      witnessed: fields.witnessed,
      gaps: [],
      reviewReasons: [],
      unresolvedAt: null,
      openedByEvent: fields.openedByEvent,
      employerSnapshotId: this.ctx.employerSnapshotId,
    };
    this.touch(session);
    return session;
  }

  // ---------------------------------------------------------------------------------------------
  // Time rules (also mirrored by the database sweep; decision #80)
  // ---------------------------------------------------------------------------------------------

  advanceTo(t: number): void {
    const s = this.s;
    if (!s.current && s.candidate) {
      const config = this.cfg(s.candidate.configVersionId);
      const lapse = ms(s.candidate.lastEvidenceAt) + this.unknownMs(config);
      if (t >= lapse) {
        const closeout = ms(s.candidate.closeoutAt);
        s.candidate = null;
        s.presenceCloseoutAt = iso(Math.max(closeout, lapse));
        this.setPresence('PRESENCE_UNKNOWN', lapse);
      }
    }
    if (!s.current && s.presence === 'PRESENCE_UNKNOWN' && s.presenceCloseoutAt) {
      const reset = ms(s.presenceCloseoutAt);
      if (t >= reset) {
        s.presenceCloseoutAt = null;
        this.setPresence('OFFSITE', reset);
      }
    }
    const session = s.current;
    for (let i = 0; i < 3 && isActive(session); i += 1) {
      const config = this.cfg(session.configVersionId);
      const staleAt = ms(session.lastSeenAt) + this.unknownMs(config);
      const closeAt = Math.max(ms(session.closeoutAt), staleAt);
      const authorizeAt =
        session.status === 'PENDING_APPROVAL' && session.authorizeAt
          ? ms(session.authorizeAt)
          : Number.POSITIVE_INFINITY;
      if (authorizeAt <= t && authorizeAt < staleAt && authorizeAt <= closeAt) {
        session.status = 'OPEN';
        session.unscheduledUntil = session.authorizeAt;
        session.closeoutAt = session.authorizedCloseoutAt ?? session.closeoutAt;
        session.authorizeAt = null;
        this.touch(session);
        continue;
      }
      if (closeAt <= t) this.markUnresolved(session, closeAt, 'CLOSEOUT_STALE');
      break;
    }
    if (this.s.evaluatedAt === null || t > ms(this.s.evaluatedAt)) this.s.evaluatedAt = iso(t);
  }

  derivePresence(t: number): void {
    const s = this.s;
    const session = s.current;
    if (session) {
      if (session.status === 'UNRESOLVED') {
        this.setPresence(
          session.endLatestAt ? 'DEPARTURE_PENDING' : 'UNRESOLVED',
          ms(session.unresolvedAt ?? session.lastSeenAt),
        );
      } else {
        const config = this.cfg(session.configVersionId);
        const staleAt = ms(session.lastSeenAt) + this.unknownMs(config);
        const restart = s.continuityBreakAt ? ms(s.continuityBreakAt) : null;
        const broken = restart !== null && restart > ms(session.lastSeenAt);
        if (!session.witnessed && (t >= staleAt || broken)) {
          this.setPresence('PRESENCE_UNKNOWN', broken && restart !== null ? restart : staleAt);
        } else {
          this.setPresence(
            session.status === 'PENDING_APPROVAL' ? 'UNSCHEDULED_PENDING' : 'ONSITE_ESTIMATED',
            t,
          );
        }
      }
      s.confidence = session.startConfidence;
      s.configVersionId = session.configVersionId;
    } else if (s.candidate) {
      this.setPresence('ARRIVING', ms(s.candidate.startedAt));
      s.confidence = 'LOW';
      s.configVersionId = s.candidate.configVersionId;
    } else {
      s.confidence = 'LOW';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Evidence handlers
  // ---------------------------------------------------------------------------------------------

  handle(item: Evidence): ItemResult {
    if (this.seen.has(item.eventUuid) || this.ctx.duplicates.has(item.eventUuid)) {
      return this.result(item, 'duplicate', null);
    }
    this.seen.add(item.eventUuid);
    const t = ms(item.observedAt);
    const received = ms(item.receivedAt);

    if (isGps(item) || item.kind === 'WITNESSED') {
      const rejection =
        this.ctx.project.status !== 'ACTIVE'
          ? 'PROJECT_NOT_ACTIVE'
          : !this.ctx.eligibility.eligible
            ? (this.ctx.eligibility.reason ?? 'ENROLLMENT_NOT_APPROVED')
            : null;
      if (rejection) {
        if (isGps(item)) {
          this.receipt(item, {
            configVersionId: item.kind === 'GEOFENCE' ? item.configVersionId : null,
            qualification: 'NOT_APPLICABLE',
            terminal: 'rejected',
            reason: rejection,
          });
        }
        return this.result(item, 'rejected', rejection);
      }
      const thresholds = this.cfgAt(t);
      const review =
        received - t > thresholds.lateReviewHours * HOUR
          ? (['LATE_EVENT_REVIEW', 'LATE_REVIEW'] as const)
          : t - received > thresholds.maxClockSkewSeconds * SECOND
            ? (['CLOCK_SKEW_REVIEW', 'CLOCK_SKEW_REVIEW'] as const)
            : item.kind === 'WITNESSED' && item.reviewReason
              ? ([item.reviewReason, 'NOT_APPLICABLE'] as const)
              : null;
      if (review) {
        if (isGps(item)) {
          this.receipt(item, {
            configVersionId: this.configForGps(item),
            qualification: review[1],
            terminal: 'accepted',
            reason: null,
          });
        } else {
          this.event(item, {
            sessionId: null,
            source: item.source,
            direction: item.direction,
            verification: 'REVIEW_REQUIRED',
            confidence: witnessedConfidence(item),
            reason: review[0],
            configVersionId: thresholds.configVersionId,
          });
        }
        return this.result(item, 'accepted', review[0], true);
      }
    }

    this.advanceTo(t);
    switch (item.kind) {
      case 'GEOFENCE':
        return item.action === 'ENTER' ? this.enter(item, t) : this.exit(item, t);
      case 'FIX':
        return this.fix(item, t);
      case 'MONITORING':
        return this.monitoring(item, t);
      case 'WITNESSED':
        return item.direction === 'ENTRY'
          ? this.witnessedEntry(item, t)
          : this.witnessedExit(item, t);
      case 'MANUAL':
        return this.manual(item);
      case 'APPROVE_UNSCHEDULED':
        return this.approve(item);
      case 'SYSTEM':
        return this.system(item, t);
    }
  }

  private belongsToPast(t: number): boolean {
    const previous = this.s.previous;
    if (this.s.current || !previous) return false;
    const end = previous.endAt ?? previous.endLatestAt;
    return end !== null && t <= ms(end);
  }

  private enter(item: Extract<Evidence, { kind: 'GEOFENCE' }>, t: number): ItemResult {
    const version = this.ctx.configs.get(item.configVersionId);
    if (!version) {
      this.receipt(item, {
        configVersionId: null,
        qualification: 'NOT_APPLICABLE',
        terminal: 'rejected',
        reason: 'CONFIG_VERSION_MISSING',
      });
      return this.result(item, 'rejected', 'CONFIG_VERSION_MISSING');
    }
    this.receipt(item, {
      configVersionId: version.configVersionId,
      qualification: 'NOT_APPLICABLE',
      terminal: 'accepted',
      reason: null,
    });
    const s = this.s;
    const session = s.current;
    if (isActive(session)) {
      if (t >= ms(session.startAt)) this.evidenceForSession(session, t, false);
      return this.result(item, 'accepted', null);
    }
    if (session && session.status === 'UNRESOLVED' && t <= this.horizon(session)) {
      this.corroborateUnresolved(session, t, false);
      return this.result(item, 'accepted', null);
    }
    if (this.belongsToPast(t)) return this.result(item, 'accepted', null);
    const current = this.cfgAt(t);
    if (version.configVersionId !== current.configVersionId) {
      // Old fence still registered on the phone: never start a new arrival under stale rules.
      this.flag('STALE_CONFIG_IDENTIFIER');
      return this.result(item, 'accepted', 'STALE_CONFIG_IDENTIFIER');
    }
    if (s.requireEnterAfter && t > ms(s.requireEnterAfter)) s.requireEnterAfter = null;
    s.lastSeenAt = maxIso(s.lastSeenAt, item.observedAt);
    const candidate = s.candidate;
    if (
      !candidate ||
      candidate.configVersionId !== version.configVersionId ||
      t - ms(candidate.lastEvidenceAt) >= this.unknownMs(version)
    ) {
      s.candidate = {
        startedAt: item.observedAt,
        firstInsideAt: null,
        firstInsideEvent: null,
        lastEvidenceAt: item.observedAt,
        configVersionId: version.configVersionId,
        closeoutAt: iso(scheduleFor(t, version, this.ctx.project.timezone).closeoutAt),
      };
    } else if (t > ms(candidate.lastEvidenceAt)) {
      candidate.lastEvidenceAt = item.observedAt;
    }
    s.presenceCloseoutAt = null;
    this.setPresence('ARRIVING', t);
    return this.result(item, 'accepted', null);
  }

  private exit(item: Extract<Evidence, { kind: 'GEOFENCE' }>, t: number): ItemResult {
    const version = this.ctx.configs.get(item.configVersionId);
    if (!version) {
      this.receipt(item, {
        configVersionId: null,
        qualification: 'NOT_APPLICABLE',
        terminal: 'rejected',
        reason: 'CONFIG_VERSION_MISSING',
      });
      return this.result(item, 'rejected', 'CONFIG_VERSION_MISSING');
    }
    const s = this.s;
    const session = s.current;
    if (
      session &&
      (isActive(session) || (session.status === 'UNRESOLVED' && session.endLatestAt === null))
    ) {
      const sessionConfig = this.cfg(session.configVersionId);
      const good =
        item.accuracyM !== null && item.accuracyM <= sessionConfig.maxHorizontalAccuracyM;
      this.receipt(item, {
        configVersionId: version.configVersionId,
        qualification: good ? 'QUALIFIED' : 'POOR_ACCURACY',
        terminal: 'accepted',
        reason: null,
      });
      if (version.versionNumber < sessionConfig.versionNumber) {
        this.flag('STALE_CONFIG_IDENTIFIER');
        return this.result(item, 'accepted', 'STALE_CONFIG_IDENTIFIER');
      }
      const lastInside = session.lastConfirmedInsideAt
        ? ms(session.lastConfirmedInsideAt)
        : ms(session.startAt);
      if (t < ms(session.startAt) || t < lastInside) {
        // Contradicted by later inside evidence (out-of-order delivery): keep the session.
        this.flag('CONTRADICTORY_EXIT');
        return this.result(item, 'accepted', 'CONTRADICTORY_EXIT', true);
      }
      const restart = s.continuityBreakAt ? ms(s.continuityBreakAt) : null;
      const timely =
        t - ms(session.lastSeenAt) < this.unknownMs(sessionConfig) &&
        !(restart !== null && restart > ms(session.lastSeenAt));
      if (good && timely) {
        this.closeSession(session, t, 'GEOFENCE', item, 'SYSTEM_CONFIRMED', 'MEDIUM');
      } else {
        this.departurePending(session, t, item, good ? 'EXIT_AFTER_SILENCE' : 'EXIT_POOR_ACCURACY');
      }
      return this.result(item, 'accepted', null);
    }
    this.receipt(item, {
      configVersionId: version.configVersionId,
      qualification: 'NOT_APPLICABLE',
      terminal: 'accepted',
      reason: null,
    });
    if (!session) {
      s.candidate = null;
      if (s.presence === 'ARRIVING' || s.presence === 'PRESENCE_UNKNOWN') {
        s.presenceCloseoutAt = null;
        this.setPresence('OFFSITE', t);
      }
    }
    return this.result(item, 'accepted', null);
  }

  private fix(item: Extract<Evidence, { kind: 'FIX' }>, t: number): ItemResult {
    const s = this.s;
    const session = s.current;
    const late =
      session !== null && session.status === 'UNRESOLVED' && t <= this.horizon(session)
        ? session
        : null;
    const config =
      isActive(session) || late
        ? this.cfg((session as SessionRecord).configVersionId)
        : this.cfgAt(t);
    const zone = classifyZone(item, config);
    if (zone === 'OUTSIDE') {
      // Privacy gate: an offsite coordinate is discarded, never stored (docs/spec/03, 11).
      this.receipt(item, {
        configVersionId: config.configVersionId,
        qualification: 'NOT_APPLICABLE',
        terminal: 'rejected',
        reason: 'COORDINATES_NOT_PERMITTED',
      });
      return this.result(item, 'rejected', 'COORDINATES_NOT_PERMITTED');
    }
    const previousFix = this.lastFix;
    const jump =
      previousFix !== null &&
      Math.abs(t - previousFix.at) <= HOUR &&
      isImplausibleJump(previousFix, {
        lat: item.lat,
        lng: item.lng,
        accuracyM: item.accuracyM,
        at: t,
      });
    if (item.mock || jump) {
      this.flag(item.mock ? 'MOCK_LOCATION' : 'SPOOF_SUSPECTED');
      this.receipt(item, {
        configVersionId: config.configVersionId,
        qualification: 'MOCK_FLAGGED',
        terminal: 'accepted',
        reason: null,
      });
      return this.result(item, 'accepted', item.mock ? 'MOCK_LOCATION' : 'SPOOF_SUSPECTED', true);
    }
    if (!previousFix || t >= previousFix.at) {
      this.lastFix = { lat: item.lat, lng: item.lng, accuracyM: item.accuracyM, at: t };
    }
    if (item.ambiguous) {
      this.flag('AMBIGUOUS_PROJECT');
      this.receipt(item, {
        configVersionId: config.configVersionId,
        qualification: 'NOT_APPLICABLE',
        terminal: 'accepted',
        reason: null,
      });
      return this.result(item, 'accepted', 'AMBIGUOUS_PROJECT', true);
    }
    if (item.accuracyM > config.maxHorizontalAccuracyM) {
      this.receipt(item, {
        configVersionId: config.configVersionId,
        qualification: 'POOR_ACCURACY',
        terminal: 'accepted',
        reason: null,
      });
      return this.result(item, 'accepted', null);
    }
    const inner = zone === 'INNER';
    this.receipt(item, {
      configVersionId: config.configVersionId,
      qualification: inner ? 'QUALIFIED' : 'NOT_APPLICABLE',
      terminal: 'accepted',
      reason: null,
    });

    if (isActive(session)) {
      if (t >= ms(session.startAt)) {
        this.evidenceForSession(session, t, inner);
        this.setPosition(item, config);
      }
      return this.result(item, 'accepted', null);
    }
    if (late) {
      this.corroborateUnresolved(late, t, inner);
      if (isActive(late)) this.setPosition(item, config);
      return this.result(item, 'accepted', null);
    }
    if (this.belongsToPast(t)) return this.result(item, 'accepted', null);
    if (s.requireEnterAfter) {
      // After a witnessed exit, a phone left on site must not restart attendance (decision #82).
      if (t > ms(s.requireEnterAfter)) this.flag('GPS_AFTER_WITNESSED_EXIT');
      return this.result(item, 'accepted', null);
    }
    s.lastSeenAt = maxIso(s.lastSeenAt, item.observedAt);
    const candidate = s.candidate;
    const unknown = this.unknownMs(config);
    if (candidate && t < ms(candidate.startedAt)) return this.result(item, 'accepted', null);
    if (!inner) {
      if (
        candidate &&
        candidate.configVersionId === config.configVersionId &&
        t - ms(candidate.lastEvidenceAt) < unknown &&
        t > ms(candidate.lastEvidenceAt)
      ) {
        candidate.lastEvidenceAt = item.observedAt;
        this.setPosition(item, config);
      }
      return this.result(item, 'accepted', null);
    }
    if (
      !candidate ||
      candidate.configVersionId !== config.configVersionId ||
      t - ms(candidate.lastEvidenceAt) >= unknown
    ) {
      s.candidate = {
        startedAt: item.observedAt,
        firstInsideAt: item.observedAt,
        firstInsideEvent: item.eventUuid,
        lastEvidenceAt: item.observedAt,
        configVersionId: config.configVersionId,
        closeoutAt: iso(scheduleFor(t, config, this.ctx.project.timezone).closeoutAt),
      };
      s.presenceCloseoutAt = null;
      this.setPresence('ARRIVING', t);
      this.setPosition(item, config);
      return this.result(item, 'accepted', null);
    }
    if (candidate.firstInsideAt === null || t < ms(candidate.firstInsideAt)) {
      if (candidate.firstInsideAt === null) {
        candidate.firstInsideAt = item.observedAt;
        candidate.firstInsideEvent = item.eventUuid;
      } else {
        candidate.firstInsideAt = item.observedAt;
        candidate.firstInsideEvent = item.eventUuid;
      }
    }
    if (t > ms(candidate.lastEvidenceAt)) candidate.lastEvidenceAt = item.observedAt;
    this.setPosition(item, config);
    const first = ms(candidate.firstInsideAt);
    if (t - first >= config.entryDwellSeconds * SECOND) this.confirmArrival(item, t, config);
    return this.result(item, 'accepted', null);
  }

  private confirmArrival(
    item: Extract<Evidence, { kind: 'FIX' }>,
    confirmedAt: number,
    config: AttendanceConfig,
  ): void {
    const s = this.s;
    const candidate = s.candidate;
    if (!candidate?.firstInsideAt || !candidate.firstInsideEvent) return;
    const start = ms(candidate.firstInsideAt);
    if (!this.endUnverifiedBefore(start)) {
      s.candidate = null;
      return;
    }
    const session = this.openSession({
      id: deriveUuid('attendance-session', candidate.firstInsideEvent),
      start,
      lastSeen: confirmedAt,
      source: 'GEOFENCE',
      confidence: 'MEDIUM',
      config,
      witnessed: false,
      openedByEvent: candidate.firstInsideEvent,
      authorized: false,
    });
    s.current = session;
    s.candidate = null;
    s.arrivalConfirmedAt = iso(confirmedAt);
    s.lastConfirmedInsideAt = maxIso(s.lastConfirmedInsideAt, iso(confirmedAt));
    s.presenceCloseoutAt = null;
    this.event(item, {
      eventUuid: candidate.firstInsideEvent,
      sessionId: session.id,
      source: 'GEOFENCE',
      direction: 'ENTRY',
      verification: session.status === 'OPEN' ? 'SYSTEM_CONFIRMED' : 'PROVISIONAL',
      confidence: 'MEDIUM',
      reason: session.status === 'OPEN' ? null : 'UNSCHEDULED_PENDING',
      configVersionId: config.configVersionId,
      observedAt: candidate.firstInsideAt,
    });
    this.setPresence(
      session.status === 'OPEN' ? 'ONSITE_ESTIMATED' : 'UNSCHEDULED_PENDING',
      confirmedAt,
    );
  }

  private monitoring(item: Extract<Evidence, { kind: 'MONITORING' }>, t: number): ItemResult {
    const s = this.s;
    this.receipt(item, {
      configVersionId: this.cfgAt(t).configVersionId,
      qualification: 'NOT_APPLICABLE',
      terminal: 'accepted',
      reason: null,
    });
    const session = s.current;
    if (item.change === 'UNAVAILABLE') {
      s.monitoring = 'UNAVAILABLE';
      if (isActive(session) && !session.witnessed && t >= ms(session.startAt)) {
        this.markUnresolved(session, Math.max(t, ms(session.lastSeenAt)), 'MONITORING_STOPPED');
      } else if (!session && s.candidate) {
        const closeout = ms(s.candidate.closeoutAt);
        s.candidate = null;
        s.presenceCloseoutAt = iso(Math.max(closeout, t));
        this.setPresence('PRESENCE_UNKNOWN', t);
      }
      this.clearPosition();
      return this.result(item, 'accepted', item.reason);
    }
    s.monitoring = 'ACTIVE';
    if (isActive(session) && t >= ms(session.lastSeenAt)) {
      s.continuityBreakAt = item.observedAt;
      if (item.change === 'REPLACED' && !session.reviewReasons.includes('DEVICE_REPLACED')) {
        session.reviewReasons.push('DEVICE_REPLACED');
        this.touch(session);
      }
    }
    return this.result(item, 'accepted', item.reason);
  }

  private witnessedEntry(item: Extract<Evidence, { kind: 'WITNESSED' }>, t: number): ItemResult {
    const s = this.s;
    const confidence = witnessedConfidence(item);
    const reason = item.source === 'KIOSK_PRINTED_BADGE' ? 'PRINTED_BADGE_WEAKER_EVIDENCE' : null;
    const session = s.current;
    const config = this.cfgAt(t);
    if (isActive(session)) {
      if (t < ms(session.startAt)) {
        this.flag('EARLIER_WITNESSED_ENTRY');
        this.event(item, {
          sessionId: session.id,
          source: item.source,
          direction: 'ENTRY',
          verification: 'REVIEW_REQUIRED',
          confidence,
          reason: 'EARLIER_THAN_SESSION_START',
          configVersionId: session.configVersionId,
        });
        return this.result(item, 'accepted', 'EARLIER_THAN_SESSION_START', true);
      }
      this.evidenceForSession(session, t, true);
      session.witnessed = true;
      this.touch(session);
      this.event(item, {
        sessionId: session.id,
        source: item.source,
        direction: 'ENTRY',
        verification: 'WITNESSED',
        confidence,
        reason,
        configVersionId: session.configVersionId,
      });
      return this.result(item, 'accepted', null);
    }
    if (session && session.status === 'UNRESOLVED' && t <= this.horizon(session)) {
      this.corroborateUnresolved(session, t, true);
      this.event(item, {
        sessionId: session.id,
        source: item.source,
        direction: 'ENTRY',
        verification: 'WITNESSED',
        confidence,
        reason,
        configVersionId: session.configVersionId,
      });
      return this.result(item, 'accepted', null);
    }
    if (this.belongsToPast(t)) {
      const previous = s.previous as SessionRecord;
      const inside = t >= ms(previous.startAt);
      if (!inside) this.flag('EARLIER_WITNESSED_ENTRY');
      this.event(item, {
        sessionId: previous.id,
        source: item.source,
        direction: 'ENTRY',
        verification: inside ? 'WITNESSED' : 'REVIEW_REQUIRED',
        confidence,
        reason: inside ? reason : 'EARLIER_THAN_SESSION_START',
        configVersionId: previous.configVersionId,
      });
      return this.result(item, 'accepted', inside ? null : 'EARLIER_THAN_SESSION_START', !inside);
    }
    if (!this.endUnverifiedBefore(t)) {
      this.event(item, {
        sessionId: null,
        source: item.source,
        direction: 'ENTRY',
        verification: 'REVIEW_REQUIRED',
        confidence,
        reason: 'OVERLAPPING_EVIDENCE',
        configVersionId: config.configVersionId,
      });
      return this.result(item, 'accepted', 'OVERLAPPING_EVIDENCE', true);
    }
    const opened = this.openSession({
      id: deriveUuid('attendance-session', item.eventUuid),
      start: t,
      lastSeen: t,
      source: item.source,
      confidence,
      config,
      witnessed: true,
      openedByEvent: item.eventUuid,
      authorized: false,
    });
    s.current = opened;
    s.candidate = null;
    s.requireEnterAfter = null;
    s.presenceCloseoutAt = null;
    s.lastSeenAt = maxIso(s.lastSeenAt, item.observedAt);
    s.lastConfirmedInsideAt = maxIso(s.lastConfirmedInsideAt, item.observedAt);
    this.event(item, {
      sessionId: opened.id,
      source: item.source,
      direction: 'ENTRY',
      verification: opened.status === 'OPEN' ? 'WITNESSED' : 'PROVISIONAL',
      confidence,
      reason: opened.status === 'OPEN' ? reason : 'UNSCHEDULED_PENDING',
      configVersionId: config.configVersionId,
    });
    this.setPresence(opened.status === 'OPEN' ? 'ONSITE_ESTIMATED' : 'UNSCHEDULED_PENDING', t);
    return this.result(item, 'accepted', null);
  }

  private witnessedExit(item: Extract<Evidence, { kind: 'WITNESSED' }>, t: number): ItemResult {
    const s = this.s;
    const confidence = witnessedConfidence(item);
    const session = s.current;
    if (session && t >= ms(session.startAt)) {
      const config = this.cfg(session.configVersionId);
      if (
        session.status === 'UNRESOLVED' &&
        t - ms(session.lastSeenAt) > config.alwaysOpenReviewHours * HOUR
      ) {
        // A scan-out long after all other evidence cannot prove the hours in between.
        this.flag('EXIT_LONG_AFTER_LAST_EVIDENCE');
        this.event(item, {
          sessionId: session.id,
          source: item.source,
          direction: 'EXIT',
          verification: 'REVIEW_REQUIRED',
          confidence,
          reason: 'EXIT_LONG_AFTER_LAST_EVIDENCE',
          configVersionId: session.configVersionId,
        });
        s.requireEnterAfter = maxIso(s.requireEnterAfter, item.observedAt);
        return this.result(item, 'accepted', 'EXIT_LONG_AFTER_LAST_EVIDENCE', true);
      }
      // A witnessed exit is the strongest departure evidence and ends the session (decision #82).
      this.closeSession(session, t, item.source, item, 'WITNESSED', confidence);
      s.requireEnterAfter = item.observedAt;
      return this.result(item, 'accepted', null);
    }
    const previous = s.previous;
    if (!session && previous && t >= ms(previous.startAt)) {
      const end = previous.endAt ? ms(previous.endAt) : null;
      const differs =
        end !== null &&
        Math.abs(end - t) > this.cfg(previous.configVersionId).maxClockSkewSeconds * SECOND;
      if (differs) this.flag('WITNESSED_EXIT_DIFFERS');
      this.event(item, {
        sessionId: previous.id,
        source: item.source,
        direction: 'EXIT',
        verification: differs ? 'REVIEW_REQUIRED' : 'WITNESSED',
        confidence,
        reason: differs ? 'WITNESSED_EXIT_DIFFERS' : null,
        configVersionId: previous.configVersionId,
      });
      if (end === null || t >= end)
        s.requireEnterAfter = maxIso(s.requireEnterAfter, item.observedAt);
      return this.result(item, 'accepted', differs ? 'WITNESSED_EXIT_DIFFERS' : null, differs);
    }
    this.flag('EXIT_WITHOUT_SESSION');
    this.event(item, {
      sessionId: null,
      source: item.source,
      direction: 'EXIT',
      verification: 'REVIEW_REQUIRED',
      confidence,
      reason: 'EXIT_WITHOUT_SESSION',
      configVersionId: this.cfgAt(t).configVersionId,
    });
    s.candidate = null;
    s.requireEnterAfter = maxIso(s.requireEnterAfter, item.observedAt);
    return this.result(item, 'accepted', 'EXIT_WITHOUT_SESSION', true);
  }

  private findSession(id: string): SessionRecord | null {
    if (this.s.current?.id === id) return this.s.current;
    if (this.s.previous?.id === id) return this.s.previous;
    const extra = this.ctx.extraSessions.get(id);
    if (!extra) return null;
    const copy = cloneSession(extra) as SessionRecord;
    return this.touched.get(id) ?? copy;
  }

  private knownSessions(): SessionRecord[] {
    const out = new Map<string, SessionRecord>();
    for (const session of this.ctx.extraSessions.values()) out.set(session.id, session);
    for (const session of [this.s.previous, this.s.current])
      if (session) out.set(session.id, session);
    for (const session of this.touched.values()) out.set(session.id, session);
    return [...out.values()].filter((session) => session.status !== 'VOID');
  }

  private overlaps(start: number, end: number | null, exceptId: string | null): boolean {
    return this.knownSessions().some((other) => {
      if (other.id === exceptId) return false;
      const otherStart = ms(other.startAt);
      const otherEnd = other.endAt ?? other.endLatestAt;
      const otherEndMs = otherEnd ? ms(otherEnd) : Number.POSITIVE_INFINITY;
      const endMs = end ?? Number.POSITIVE_INFINITY;
      return start < otherEndMs && otherStart < endMs;
    });
  }

  private manual(item: Extract<Evidence, { kind: 'MANUAL' }>): ItemResult {
    const s = this.s;
    if (item.sessionId) {
      const target = this.findSession(item.sessionId);
      if (!target || target.projectId !== s.projectId || target.workerId !== s.workerId) {
        return this.result(item, 'rejected', 'SESSION_NOT_FOUND');
      }
      const start = item.correctedStartAt ?? target.startAt;
      const end = item.correctedEndAt ?? target.endAt;
      if (end !== null && ms(end) < ms(start))
        return this.result(item, 'rejected', 'INVALID_CORRECTION');
      if (this.overlaps(ms(start), end === null ? null : ms(end), target.id)) {
        return this.result(item, 'rejected', 'OVERLAPPING_SESSION');
      }
      const original = {
        start_at: target.startAt,
        end_at: target.endAt,
        status: target.status,
        start_source: target.startSource,
        end_source: target.endSource,
      };
      if (item.correctedStartAt) {
        target.startAt = item.correctedStartAt;
        target.startSource = 'MANUAL';
      }
      if (item.correctedEndAt) {
        target.endAt = item.correctedEndAt;
        target.endSource = 'MANUAL';
        target.status = 'CLOSED';
        target.endEarliestAt = null;
        target.endLatestAt = null;
        target.unresolvedAt = null;
      }
      this.touch(target);
      if (s.current?.id === target.id && target.status === 'CLOSED') {
        s.previous = target;
        s.current = null;
        s.candidate = null;
        this.setPresence('OFFSITE', ms(item.observedAt));
        this.clearPosition();
      }
      this.corrections.push({
        session_id: target.id,
        project_id: s.projectId,
        worker_id: s.workerId,
        requested_by: item.actorId,
        approved_by: item.actorId,
        reason: item.reason,
        original_json: original,
        proposed_json: { start_at: target.startAt, end_at: target.endAt, status: target.status },
        action_at: item.receivedAt,
        event_uuid: item.eventUuid,
      });
      this.event(item, {
        sessionId: target.id,
        source: 'MANUAL',
        direction: 'CORRECT',
        verification: 'CORRECTED',
        confidence: 'HIGH',
        reason: item.reason,
        configVersionId: target.configVersionId,
      });
      return this.result(item, 'accepted', null);
    }
    // Manual attendance entry by authorized staff (new session; never PENDING_APPROVAL).
    const start = ms(item.correctedStartAt ?? item.observedAt);
    const end = item.correctedEndAt ? ms(item.correctedEndAt) : null;
    if (end !== null && end < start) return this.result(item, 'rejected', 'INVALID_CORRECTION');
    if (end === null && s.current) return this.result(item, 'rejected', 'OVERLAPPING_SESSION');
    if (this.overlaps(start, end, null))
      return this.result(item, 'rejected', 'OVERLAPPING_SESSION');
    const config = this.cfgAt(start);
    const session = this.openSession({
      id: deriveUuid('attendance-session', item.eventUuid),
      start,
      lastSeen: end ?? start,
      source: 'MANUAL',
      confidence: 'HIGH',
      config,
      witnessed: true,
      openedByEvent: item.eventUuid,
      authorized: true,
      approvedBy: item.actorId,
    });
    if (end !== null) {
      session.status = 'CLOSED';
      session.endAt = iso(end);
      session.endSource = 'MANUAL';
      if (!s.previous || ms(s.previous.startAt) <= start) s.previous = session;
    } else {
      s.current = session;
      s.candidate = null;
      s.requireEnterAfter = null;
      s.lastSeenAt = maxIso(s.lastSeenAt, iso(start));
      this.setPresence('ONSITE_ESTIMATED', start);
    }
    this.touch(session);
    this.corrections.push({
      session_id: session.id,
      project_id: s.projectId,
      worker_id: s.workerId,
      requested_by: item.actorId,
      approved_by: item.actorId,
      reason: item.reason,
      original_json: {},
      proposed_json: { start_at: session.startAt, end_at: session.endAt, status: session.status },
      action_at: item.receivedAt,
      event_uuid: item.eventUuid,
    });
    this.event(item, {
      sessionId: session.id,
      source: 'MANUAL',
      direction: 'ENTRY',
      verification: 'WITNESSED',
      confidence: 'HIGH',
      reason: item.reason,
      configVersionId: config.configVersionId,
      observedAt: session.startAt,
    });
    return this.result(item, 'accepted', null);
  }

  private approve(item: Extract<Evidence, { kind: 'APPROVE_UNSCHEDULED' }>): ItemResult {
    const target = this.findSession(item.sessionId);
    if (!target || !target.unscheduled || target.overtimeApprovedAt || target.status === 'VOID') {
      return this.result(item, 'rejected', 'NOT_PENDING_APPROVAL');
    }
    target.overtimeApprovedAt = item.observedAt;
    target.overtimeApprovedBy = item.actorId;
    if (target.status === 'PENDING_APPROVAL') {
      target.status = 'OPEN';
      target.authorizeAt = null;
      // The pending deadline (next window minus grace) no longer applies once approved: the
      // session closes out like an authorized one — at the end of the window it runs into —
      // capped by the 16 h review, never before the shift it was approved for.
      const cap =
        ms(target.startAt) + this.cfg(target.configVersionId).alwaysOpenReviewHours * HOUR;
      target.closeoutAt = iso(
        target.authorizedCloseoutAt ? Math.min(cap, ms(target.authorizedCloseoutAt)) : cap,
      );
    }
    this.touch(target);
    this.event(item, {
      sessionId: target.id,
      source: 'MANUAL',
      direction: 'VERIFY',
      verification: 'WITNESSED',
      confidence: 'HIGH',
      reason: 'UNSCHEDULED_APPROVED',
      configVersionId: target.configVersionId,
    });
    return this.result(item, 'accepted', null);
  }

  private system(item: Extract<Evidence, { kind: 'SYSTEM' }>, t: number): ItemResult {
    const s = this.s;
    const session = s.current;
    if (isActive(session)) {
      this.markUnresolved(session, Math.max(t, ms(session.lastSeenAt)), item.change);
    } else if (!session) {
      s.candidate = null;
      s.presenceCloseoutAt = null;
      this.setPresence('OFFSITE', t);
    }
    this.clearPosition();
    return this.result(item, 'accepted', item.reason);
  }

  finish(now: number, results: ItemResult[]): EngineOutput {
    this.advanceTo(now);
    this.derivePresence(now);
    return {
      state: this.s,
      sessions: [...this.touched.values()],
      events: this.events,
      receipts: this.receipts,
      corrections: this.corrections,
      position: this.position,
      results,
    };
  }

  setNow(now: number): void {
    this.now = now;
  }
}

/** Process a batch of evidence for one worker on one project (results in input order). */
export function processEvidence(
  state: TrackState,
  items: readonly Evidence[],
  ctx: EngineContext,
  now: string,
): EngineOutput {
  const machine = new Machine(state, ctx);
  const nowMs = ms(now);
  machine.setNow(nowMs);
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => ms(a.item.observedAt) - ms(b.item.observedAt) || a.index - b.index);
  const results: ItemResult[] = new Array<ItemResult>(items.length);
  for (const { item, index } of ordered) results[index] = machine.handle(item);
  return machine.finish(nowMs, results);
}

/** Apply only the time rules up to `now` (the scheduled sweep). */
export function advanceTrack(state: TrackState, ctx: EngineContext, now: string): EngineOutput {
  const machine = new Machine(state, ctx);
  const nowMs = ms(now);
  machine.setNow(nowMs);
  return machine.finish(nowMs, []);
}
