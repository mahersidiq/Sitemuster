import { z } from 'zod';

import { ORGANIZATION_ROLES, PROJECT_STAFF_ROLES } from '@sitemuster/shared';

/** Shape of public.get_my_access() (own data only; server still enforces every request). */
export const AccessSchema = z.object({
  user_id: z.uuid(),
  aal: z.enum(['aal1', 'aal2']),
  email_verified: z.boolean(),
  phone_verified: z.boolean(),
  is_platform_operator: z.boolean(),
  worker_profile_id: z.uuid().nullable(),
  is_foreman: z.boolean(),
  org_roles: z.array(z.object({ organization_id: z.uuid(), role: z.enum(ORGANIZATION_ROLES) })),
  project_roles: z.array(z.object({ project_id: z.uuid(), role: z.enum(PROJECT_STAFF_ROLES) })),
});
export type Access = z.infer<typeof AccessSchema>;

export function hasStaffRole(access: Access): boolean {
  return access.org_roles.length > 0 || access.project_roles.length > 0;
}

/** Staff path: staff roles, or an email-verified identity without a phone (GC staff signing in). */
export function isStaffCandidate(access: Access): boolean {
  return hasStaffRole(access) || (access.email_verified && !access.phone_verified);
}
