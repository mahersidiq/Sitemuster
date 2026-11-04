import type { AttendanceSource, PresenceState, ProjectStatus, SessionStatus } from '../enums.ts';

/**
 * Attendance engine model (docs/spec/04, 05, 06; decisions #78–#86).
 * Presence, sessions, monitoring and enrollment are separate facts — never one `is_on_site` flag.
 */

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type Verification =
  'PROVISIONAL' | 'SYSTEM_CONFIRMED' | 'WITNESSED' | 'REVIEW_REQUIRED' | 'DISPUTED' | 'CORRECTED';
export type Qualification =
  | 'QUALIFIED'
  | 'POOR_ACCURACY'
  | 'CLOCK_SKEW_REVIEW'
  | 'LATE_REVIEW'
  | 'MOCK_FLAGGED'
  | 'NOT_APPLICABLE';
export type MonitoringStatus = 'ACTIVE' | 'UNAVAILABLE';
export type Zone = 'INNER' | 'BAND' | 'OUTSIDE';
export type WitnessedSource = 'KIOSK_DYNAMIC_BADGE' | 'KIOSK_PRINTED_BADGE' | 'FOREMAN';

export interface WorkWindowSpec {
  weekday: number;
  local_start_time: string;
  local_end_time: string;
}

/** One immutable project configuration version, as the engine needs it. */
export interface AttendanceConfig {
  configVersionId: string;
  projectId: string;
  versionNumber: number;
  effectiveAt: string;
  center: { lat: number; lng: number };
  radiusM: number;
  exitHysteresisM: number;
  entryDwellSeconds: number;
  maxHorizontalAccuracyM: number;
  locationFreshSeconds: number;
  presenceUnknownSeconds: number;
  lateReviewHours: number;
  maxClockSkewSeconds: number;
  workWindowGraceMinutes: number;
  closeoutGraceMinutes: number;
  alwaysOpenReviewHours: number;
  operates24x7: boolean;
  windows: WorkWindowSpec[];
}

export interface ProjectContext {
  id: string;
  status: ProjectStatus;
  timezone: string;
}

export interface Gap {
  from: string;
  to: string;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  workerId: string;
  status: SessionStatus;
  startAt: string;
  startSource: AttendanceSource;
  startConfidence: Confidence;
  endAt: string | null;
  endSource: AttendanceSource | null;
  endEarliestAt: string | null;
  endLatestAt: string | null;
  configVersionId: string;
  timezone: string;
  lastSeenAt: string;
  lastConfirmedInsideAt: string | null;
  closeoutAt: string;
  authorizeAt: string | null;
  authorizedCloseoutAt: string | null;
  windowStartAt: string | null;
  windowEndAt: string | null;
  unscheduled: boolean;
  unscheduledUntil: string | null;
  overtimeApprovedAt: string | null;
  overtimeApprovedBy: string | null;
  /** A kiosk, foreman or staff member saw the worker enter (no-phone presence support). */
  witnessed: boolean;
  /** Periods without presence evidence (≥ presence_unknown_seconds or a monitoring restart). */
  gaps: Gap[];
  reviewReasons: string[];
  unresolvedAt: string | null;
  openedByEvent: string;
  employerSnapshotId: string | null;
}

export interface Candidate {
  startedAt: string;
  firstInsideAt: string | null;
  firstInsideEvent: string | null;
  lastEvidenceAt: string;
  configVersionId: string;
  /** Close-out instant of the shift the observation started in (stored, so the sweep needs no calendar logic). */
  closeoutAt: string;
}

/** Per (project, worker) attendance state; persisted coordinate-free in `presence_states`. */
export interface TrackState {
  projectId: string;
  workerId: string;
  revision: number;
  presence: PresenceState;
  presenceChangedAt: string | null;
  confidence: Confidence;
  monitoring: MonitoringStatus;
  candidate: Candidate | null;
  lastSeenAt: string | null;
  lastConfirmedInsideAt: string | null;
  arrivalConfirmedAt: string | null;
  evaluatedAt: string | null;
  presenceCloseoutAt: string | null;
  requireEnterAfter: string | null;
  continuityBreakAt: string | null;
  flags: string[];
  configVersionId: string;
  /** OPEN, PENDING_APPROVAL or UNRESOLVED (at most one, enforced by the database). */
  current: SessionRecord | null;
  /** Most recent ended session (CLOSED or ENDED_UNVERIFIED), for duplicates and late evidence. */
  previous: SessionRecord | null;
}

interface EvidenceBase {
  eventUuid: string;
  projectId: string;
  workerId: string;
  observedAt: string;
  receivedAt: string;
}

/** Server-normalized inputs. Identity and project always come from credentials, never payloads. */
export type Evidence =
  | (EvidenceBase & {
      kind: 'GEOFENCE';
      action: 'ENTER' | 'EXIT';
      configVersionId: string;
      accuracyM: number | null;
      deviceId: string;
    })
  | (EvidenceBase & {
      kind: 'FIX';
      deviceId: string;
      lat: number;
      lng: number;
      accuracyM: number;
      mock: boolean;
      ambiguous: boolean;
    })
  | (EvidenceBase & {
      kind: 'MONITORING';
      deviceId: string;
      change: 'UNAVAILABLE' | 'RESTARTED' | 'REPLACED';
      reason: string;
    })
  | (EvidenceBase & {
      kind: 'WITNESSED';
      source: WitnessedSource;
      direction: 'ENTRY' | 'EXIT';
      actorId: string;
      kioskDeviceId: string | null;
      method: 'PHYSICAL_CONFIRMATION' | 'FOREMAN_REPORT' | null;
      /** Set by the operations normalizer (e.g. kiosk clock skew): recorded, never auto-applied. */
      reviewReason: string | null;
    })
  | (EvidenceBase & {
      kind: 'MANUAL';
      actorId: string;
      sessionId: string | null;
      correctedStartAt: string | null;
      correctedEndAt: string | null;
      reason: string;
    })
  | (EvidenceBase & { kind: 'APPROVE_UNSCHEDULED'; actorId: string; sessionId: string })
  | (EvidenceBase & {
      kind: 'SYSTEM';
      change: 'ELIGIBILITY_LOST' | 'PROJECT_INACTIVE';
      reason: string;
    });

export type EvidenceKind = Evidence['kind'];

export interface ItemResult {
  eventUuid: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason: string | null;
  /** Accepted and stored, but held for human review instead of changing attendance. */
  review: boolean;
}

export interface AttendanceEventRow {
  event_uuid: string;
  worker_id: string;
  project_id: string;
  session_id: string | null;
  actor_id: string | null;
  kiosk_device_id: string | null;
  device_id: string | null;
  config_version_id: string;
  source: AttendanceSource;
  direction: 'ENTRY' | 'EXIT' | 'VERIFY' | 'CORRECT';
  observed_at: string;
  received_at: string;
  verification_status: Verification;
  confidence: Confidence;
  reason: string | null;
}

/** Coordinate-free, append-only outcome of one device record (`location_event_receipts`). */
export interface ReceiptRow {
  event_uuid: string;
  device_id: string;
  worker_id: string;
  project_id: string | null;
  config_version_id: string | null;
  event_type: 'GEOFENCE_ENTER' | 'GEOFENCE_EXIT' | 'ONSITE_FIX' | 'OTHER';
  observed_at: string;
  server_received_at: string;
  accuracy_m: number | null;
  qualification_state: Qualification;
  terminal_result: 'accepted' | 'duplicate' | 'rejected';
  rejection_reason: string | null;
}

export interface CorrectionRow {
  session_id: string;
  project_id: string;
  worker_id: string;
  requested_by: string;
  approved_by: string;
  reason: string;
  original_json: Record<string, unknown>;
  proposed_json: Record<string, unknown>;
  action_at: string;
  event_uuid: string;
}

export type PositionEffect =
  | { op: 'set'; lat: number; lng: number; accuracyM: number; observedAt: string; expiryAt: string }
  | { op: 'clear' };

export interface EngineContext {
  project: ProjectContext;
  configs: ReadonlyMap<string, AttendanceConfig>;
  eligibility: { eligible: boolean; reason: string | null };
  duplicates: ReadonlySet<string>;
  lastPosition: { lat: number; lng: number; accuracyM: number; observedAt: string } | null;
  /** Older sessions referenced by staff corrections or approvals (loaded by id). */
  extraSessions: ReadonlyMap<string, SessionRecord>;
  /** Other sessions of this worker on this project (for overlap checks of manual entries). */
  employerSnapshotId: string | null;
}

export interface EngineOutput {
  state: TrackState;
  /** Sessions created or changed by this call (full records). */
  sessions: SessionRecord[];
  events: AttendanceEventRow[];
  receipts: ReceiptRow[];
  corrections: CorrectionRow[];
  position: PositionEffect | null;
  results: ItemResult[];
}
