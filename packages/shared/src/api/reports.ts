import { z } from 'zod';

import { SchemaVersionSchema, UtcIsoSchema, UuidSchema } from './common.ts';

/**
 * Daily company reports and foreman confirmation (docs/spec/11 "Other Edge endpoints":
 * `report-confirm`; docs/spec/04 "Report and confirmation lifecycle"; Milestone 10).
 * Reports are ESTIMATES of onsite presence — never payroll, contract proof or back-charges.
 */
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ReportStatusSchema = z.enum([
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'DISPUTED',
  'CORRECTION_REQUESTED',
  'NOT_CONFIRMED',
  'SUPERSEDED',
]);

export const ReportActionSchema = z.enum(['CONFIRM', 'DISPUTE', 'SUBMIT_CORRECTION']);
export type ReportAction = z.infer<typeof ReportActionSchema>;

/** One proposed change for one worker of the report (a session, or a missing visit). */
export const ProposedCorrectionSchema = z
  .strictObject({
    worker_id: UuidSchema,
    session_id: UuidSchema.nullable(),
    proposed_start_at: UtcIsoSchema.nullable(),
    proposed_end_at: UtcIsoSchema.nullable(),
    note: z.string().trim().max(500).nullable(),
  })
  .refine((v) => v.proposed_start_at !== null || v.proposed_end_at !== null, {
    message: 'PROPOSAL_REQUIRED',
  })
  .refine(
    (v) =>
      v.proposed_start_at === null ||
      v.proposed_end_at === null ||
      Date.parse(v.proposed_start_at) < Date.parse(v.proposed_end_at),
    { message: 'END_BEFORE_START' },
  )
  .refine((v) => v.session_id !== null || (v.proposed_start_at && v.proposed_end_at), {
    message: 'MISSING_VISIT_NEEDS_BOTH_TIMES',
  });
export type ProposedCorrection = z.infer<typeof ProposedCorrectionSchema>;

export const ReportConfirmRequestSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    report_id: UuidSchema,
    version: z.number().int().min(1),
    action: ReportActionSchema,
    reason: z.string().trim().min(3).max(2000).nullable(),
    proposed: z.array(ProposedCorrectionSchema).max(100),
    event_uuid: UuidSchema,
  })
  .superRefine((value, ctx) => {
    if (value.action !== 'CONFIRM' && !value.reason) {
      ctx.addIssue({ code: 'custom', message: 'REASON_REQUIRED', path: ['reason'] });
    }
    if (value.action === 'SUBMIT_CORRECTION' && value.proposed.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'PROPOSAL_REQUIRED', path: ['proposed'] });
    }
    if (value.action !== 'SUBMIT_CORRECTION' && value.proposed.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'PROPOSAL_NOT_EXPECTED', path: ['proposed'] });
    }
  });
export type ReportConfirmRequest = z.infer<typeof ReportConfirmRequestSchema>;

export const ReportConfirmResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  report_id: UuidSchema,
  version: z.number().int().min(1),
  status: ReportStatusSchema,
  duplicate: z.boolean(),
});
export type ReportConfirmResponse = z.infer<typeof ReportConfirmResponseSchema>;

export const DailyReportsRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    schema_version: SchemaVersionSchema,
    action: z.literal('list'),
    project_id: UuidSchema,
    local_date: LocalDateSchema,
  }),
  z.strictObject({ schema_version: SchemaVersionSchema, action: z.literal('pending') }),
  z.strictObject({
    schema_version: SchemaVersionSchema,
    action: z.literal('reissue'),
    project_id: UuidSchema,
    company_id: UuidSchema,
    local_date: LocalDateSchema,
    reason: z.string().trim().min(3).max(1000),
  }),
]);
export type DailyReportsRequest = z.infer<typeof DailyReportsRequestSchema>;

const SessionLineSchema = z.object({
  session_id: UuidSchema,
  start_at: z.string(),
  end_at: z.string().nullable(),
  end_latest_at: z.string().nullable(),
  start_source: z.string(),
  end_source: z.string().nullable(),
  status: z.string(),
  witnessed: z.boolean(),
  definite_seconds: z.number(),
  uncertain_seconds: z.number(),
  pending_approval_seconds: z.number(),
  needs_review: z.boolean(),
  corrected: z.boolean(),
});

/** A report as a staff member or foreman sees it (names joined from authorized rows). */
export const ReportViewSchema = z.object({
  report_id: UuidSchema,
  project_id: UuidSchema,
  project_name: z.string(),
  company_id: UuidSchema,
  company_name: z.string(),
  local_date: LocalDateSchema,
  version: z.number().int().min(1),
  status: ReportStatusSchema,
  due_at: z.string(),
  generated_at: z.string(),
  can_answer: z.boolean(),
  summary: z.object({
    time_zone: z.string(),
    workers: z.array(
      z.object({
        worker_id: UuidSchema,
        definite_seconds: z.number(),
        uncertain_seconds: z.number(),
        pending_approval_seconds: z.number(),
        needs_review: z.boolean(),
        sessions: z.array(SessionLineSchema),
      }),
    ),
    totals: z.object({
      workers: z.number(),
      definite_seconds: z.number(),
      uncertain_seconds: z.number(),
      pending_approval_seconds: z.number(),
      sessions_needing_review: z.number(),
      peak_estimated_count: z.number(),
    }),
  }),
  worker_names: z.record(z.string(), z.string()),
  answers: z.array(
    z.object({
      version: z.number().int(),
      action: ReportActionSchema,
      comment: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  earlier_versions: z.array(z.object({ version: z.number().int(), status: ReportStatusSchema })),
});
export type ReportView = z.infer<typeof ReportViewSchema>;

export const DailyReportsResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  /** The project-local day has not ended yet: nothing is generated for it. */
  day_open: z.boolean(),
  reports: z.array(ReportViewSchema),
});
export type DailyReportsResponse = z.infer<typeof DailyReportsResponseSchema>;
