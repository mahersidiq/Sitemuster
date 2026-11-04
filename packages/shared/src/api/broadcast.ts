import { z } from 'zod';

import { SchemaVersionSchema, UtcIsoSchema, UuidSchema } from './common.ts';

/**
 * Private Realtime Broadcast invalidation message on topic `project:{uuid}` (decision #19).
 * Only IDs, aggregate counts and versions: no names, contacts, coordinates or badge tokens.
 */
const Count = z.number().int().nonnegative();

export const BroadcastSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  type: z.enum([
    'WORKFORCE_CHANGED',
    'ENROLLMENT_CHANGED',
    'REPORT_CHANGED',
    'MUSTER_CHANGED',
    'PROJECT_CONFIG_CHANGED',
  ]),
  project_id: UuidSchema,
  aggregate_version: Count,
  counts: z.strictObject({
    estimated_onsite: Count.optional(),
    presence_unknown: Count.optional(),
    approved_roster: Count.optional(),
    visitors_onsite: Count.optional(),
  }),
  changed_ids: z.array(UuidSchema).max(100),
  occurred_at: UtcIsoSchema,
});
export type BroadcastMessage = z.infer<typeof BroadcastSchema>;

export function projectTopic(projectId: string): string {
  return `project:${UuidSchema.parse(projectId)}`;
}
