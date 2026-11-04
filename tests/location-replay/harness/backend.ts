import type {
  AttendanceConfig,
  AttendanceStore,
  ItemResult,
  ProjectContext,
  ReceiptRow,
  SessionRecord,
  TrackState,
  VisitorEvent,
  VisitRecord,
} from '@sitemuster/shared';

/**
 * What the replay harness needs from a server. Two implementations: in memory (Vitest `replay`
 * project, every CI run) and the real local Postgres through the production reconciler RPCs and
 * the SQL sweep (Vitest `backend` project, decision #80 parity).
 */
export interface Eligibility {
  eligible: boolean;
  reason: string | null;
  employerId?: string | null;
}

export interface StoredPosition {
  lat: number;
  lng: number;
  accuracyM: number;
  observedAt: string;
  expiryAt: string;
}

export interface BackendSnapshot {
  tracks: TrackState[];
  sessions: SessionRecord[];
  receipts: number;
  events: number;
  positions: StoredPosition[];
  visits: VisitRecord[];
}

export interface ServerBackend {
  readonly mode: 'memory' | 'database';
  readonly store: AttendanceStore;
  createProject(project: ProjectContext, first: AttendanceConfig): Promise<void>;
  addConfigVersion(config: AttendanceConfig): Promise<void>;
  setProjectStatus(projectId: string, status: ProjectContext['status']): Promise<void>;
  enrollWorker(projectId: string, workerId: string, eligibility: Eligibility): Promise<void>;
  setEligibility(projectId: string, workerId: string, eligibility: Eligibility): Promise<void>;
  /** Personal tracking devices and kiosks referenced by receipts and events. */
  registerDevice(deviceId: string, workerId: string): Promise<void>;
  deactivateDevice(deviceId: string): Promise<void>;
  registerKiosk(kioskId: string, projectId: string): Promise<void>;
  /** Terminal receipts decided before the engine (normalizer rejections, proof-of-life). */
  insertReceipts(rows: readonly ReceiptRow[]): Promise<void>;
  /** Production ingest hooks: durable outcomes (+ quarantine copies) and receipt ownership. */
  recordTerminals(
    requestId: string,
    rows: readonly ReceiptRow[],
    quarantine: readonly Record<string, unknown>[],
  ): Promise<void>;
  receiptOwners(eventUuids: readonly string[]): Promise<Map<string, string>>;
  /** The scheduled close-out sweep at `now` (time rules only). */
  sweep(now: string): Promise<void>;
  visitorEvent(event: VisitorEvent): Promise<ItemResult>;
  snapshot(projectId: string): Promise<BackendSnapshot>;
  close(): Promise<void>;
}
