import { z } from 'zod';

import { PRESENCE_STATES } from '../enums.ts';
import { SchemaVersionSchema, TerminalStatusSchema, UuidSchema } from './common.ts';

/**
 * Reviewer demo (Milestone 13; spec 09 "Reviewer/demo mode", spec 07 "Review simulation tries live
 * project"; decisions #38, #140–#143).
 *
 * POST /functions/v1/demo-simulate with the caller's JWT. It works only for the synthetic workers
 * of an allowlisted demo organization, checked by the database. The client names the person and
 * the action, nothing else: the server builds every record (times, the place, the phone record).
 */
export const DEMO_ACTIONS = ['ARRIVE', 'LEAVE'] as const;
export type DemoAction = (typeof DEMO_ACTIONS)[number];

/**
 * A simulated arrival is a synthetic trace that ends now: the geofence ENTER and a first on-site
 * fix this many seconds ago, a second fix now. It is the production 10-minute rule plus a margin,
 * so the production engine confirms it at once (decision #141).
 */
export const DEMO_ARRIVAL_SPAN_SECONDS = 610;

export const DemoSimulateRequestSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  project_id: UuidSchema,
  worker_id: UuidSchema,
  action: z.enum(DEMO_ACTIONS),
  idempotency_key: UuidSchema,
});
export type DemoSimulateRequest = z.infer<typeof DemoSimulateRequestSchema>;

export const DemoSimulateResponseSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  request_id: UuidSchema,
  action: z.enum(DEMO_ACTIONS),
  /** Always true: labels every answer as a simulation, never a real phone or GPS reading. */
  simulated: z.literal(true),
  results: z
    .array(
      z.strictObject({
        event_uuid: UuidSchema,
        status: TerminalStatusSchema,
        reason: z.string().nullable(),
      }),
    )
    .min(1)
    .max(3),
});
export type DemoSimulateResponse = z.infer<typeof DemoSimulateResponseSchema>;

/** `my_demo_projects()`: the demo projects the signed-in person belongs to. */
export const DemoProjectSchema = z.strictObject({
  project_id: UuidSchema,
  organization_id: UuidSchema,
  active: z.boolean(),
});
export type DemoProject = z.infer<typeof DemoProjectSchema>;

/** `demo_workers(project)`: the synthetic people a simulation may move. */
export const DemoWorkerSchema = z.strictObject({
  worker_id: UuidSchema,
  name: z.string(),
  company_name: z.string().nullable(),
  presence: z.enum(PRESENCE_STATES).nullable(),
  last_seen_at: z.string().nullable(),
});
export type DemoWorker = z.infer<typeof DemoWorkerSchema>;
