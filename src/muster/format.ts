import type { MusterCounts } from '@sitemuster/shared';

import type { MusterMemberRow, MusterMemberStatus, MusterReportView } from '../api/types';
import { effectiveOutcome, type OutboxEntry } from '../outbox/outbox';

/**
 * Pure helpers for the muster screens (docs/spec/12, Milestone 11). The server's counts are the
 * authoritative ones; checks still on this phone are shown next to them, never added into them.
 */

/** The order people are listed in: the ones still needing a physical check first. */
export const STATUS_ORDER: readonly MusterMemberStatus[] = [
  'UNACCOUNTED',
  'STATUS_UNKNOWN',
  'SELF_REPORTED_SAFE',
  'VERIFIED_ACCOUNTED',
];

export type MemberFilter = 'OPEN' | 'ALL' | 'VISITORS';

/** "Not seen yet" = everyone without a physical check (a self report is not one). */
export function filterMembers(members: MusterMemberRow[], filter: MemberFilter): MusterMemberRow[] {
  const shown = members.filter((member) =>
    filter === 'VISITORS'
      ? member.kind === 'VISITOR'
      : filter === 'OPEN'
        ? member.status !== 'VERIFIED_ACCOUNTED'
        : true,
  );
  return [...shown].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.name.localeCompare(b.name),
  );
}

/** People the commander must explicitly acknowledge before closing. */
export function unresolvedCount(counts: MusterCounts): number {
  return counts.workers.unaccounted + counts.workers.unknown + counts.visitors.unaccounted;
}

type MusterEntry = OutboxEntry & {
  event: Extract<
    OutboxEntry['event'],
    { operation_type: 'MUSTER_SELF_REPORT' | 'MUSTER_PHYSICAL_VERIFY' }
  >;
};

function isMusterEntry(entry: OutboxEntry, musterId: string): entry is MusterEntry {
  return (
    (entry.event.operation_type === 'MUSTER_SELF_REPORT' ||
      entry.event.operation_type === 'MUSTER_PHYSICAL_VERIFY') &&
    entry.event.payload.muster_id === musterId
  );
}

/** This phone's muster records for one muster, oldest first. */
export function musterEntries(entries: OutboxEntry[], musterId: string): MusterEntry[] {
  return entries.filter((entry): entry is MusterEntry => isMusterEntry(entry, musterId));
}

/** Checks recorded on this phone that the server has not answered yet (PENDING_SYNC). */
export function pendingChecks(entries: OutboxEntry[], musterId: string): number {
  return musterEntries(entries, musterId).filter((entry) => effectiveOutcome(entry) === 'PENDING')
    .length;
}

/** The latest tap-to-verify record this phone made for one person on the list. */
export function latestCheckFor(
  entries: OutboxEntry[],
  musterId: string,
  memberId: string,
): MusterEntry | null {
  const mine = musterEntries(entries, musterId).filter(
    (entry) => entry.event.payload.snapshot_member_id === memberId,
  );
  return mine[mine.length - 1] ?? null;
}

/** The worker's own latest I'M SAFE record for one muster (app or notification button). */
export function latestSelfReport(entries: OutboxEntry[], musterId: string): MusterEntry | null {
  const mine = musterEntries(entries, musterId).filter(
    (entry) => entry.event.operation_type === 'MUSTER_SELF_REPORT',
  );
  return mine[mine.length - 1] ?? null;
}

/** Kiosk badge scans for one muster, newest first. */
export function musterScans(entries: OutboxEntry[], musterId: string): MusterEntry[] {
  return musterEntries(entries, musterId)
    .filter((entry) => entry.event.payload.badge_payload !== undefined)
    .reverse();
}

export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The shareable plain-text summary of a closed muster (docs/spec/12 "Basic V1 screen/shareable
 * textual summary"; no PDF in V1). It repeats the not-life-safety notice and lists everyone who
 * was not physically accounted for by name.
 */
export function musterSummaryText(
  view: MusterReportView,
  t: Translate,
  time: (iso: string) => string,
): string {
  const { report } = view;
  const status = (value: MusterMemberStatus) => t(`muster.status.${value}`);
  const unresolved = report.members.filter(
    (member) => member.final_status === 'UNACCOUNTED' || member.final_status === 'STATUS_UNKNOWN',
  );
  const selfOnly = report.members.filter((member) => member.final_status === 'SELF_REPORTED_SAFE');
  const lines = [
    t('muster.summary.title', { project: report.project_name }),
    t('muster.report.notice'),
    t('muster.summary.incident', { label: report.incident_label }),
    t('muster.report.started', {
      time: time(report.started_at),
      who: report.started_by ?? t('muster.report.unknownPerson'),
    }),
    t('muster.report.ended', {
      time: time(report.ended_at),
      who: report.ended_by ?? t('muster.report.unknownPerson'),
    }),
    t('muster.report.note', { note: report.closing_note }),
    '',
    t('muster.summary.workers', {
      total: report.counts.workers.total,
      verified: report.counts.workers.verified,
      self: report.counts.workers.self_reported,
      unknown: report.counts.workers.unknown,
      unaccounted: report.counts.workers.unaccounted,
    }),
    t('muster.summary.visitors', {
      total: report.counts.visitors.total,
      verified: report.counts.visitors.verified,
      unaccounted: report.counts.visitors.unaccounted,
    }),
    '',
    t('muster.summary.unresolved', { count: unresolved.length }),
    ...unresolved.map((member) =>
      t('muster.summary.person', {
        name: member.name,
        group: member.company_name ?? member.organization ?? t('muster.noCompany'),
        status: status(member.final_status),
      }),
    ),
    t('muster.summary.selfOnly', { count: selfOnly.length }),
    ...selfOnly.map((member) =>
      t('muster.summary.person', {
        name: member.name,
        group: member.company_name ?? member.organization ?? t('muster.noCompany'),
        status: status(member.final_status),
      }),
    ),
    '',
    t('muster.report.pushLimits', {
      sent: report.push.sent,
      failed: report.push.failed,
      noDevice: report.push.no_device,
      notAttempted: report.push.not_attempted,
    }),
    t('muster.summary.amendments', { count: view.amendments.length }),
    t('muster.report.digest', { digest: view.digest.slice(0, 16) }),
  ];
  return lines.join('\n');
}
