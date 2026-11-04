# Legal translation and consent release gate (English and Spanish)

Claude Code can draft policy/disclosure texts but CANNOT approve legal translations. This file is a **review protocol**, not legal advice. Production V1 must refuse collecting project tracking consent against a non-APPROVED legal notice version. The human owner is responsible for securing qualified bilingual legal review, including state/union/subcontractor issues.

## Versioned legal document registry

| Document ID | Scope | Language | Draft status | Required reviewer | Release eligibility |
|---|---|---|---|---|---|
| `WORKER_LOCATION_DISCLOSURE_EN_V1` | Standard worker/project location | en-US | `DRAFT_REQUIRES_HUMAN_REVIEW` | Licensed employment/privacy counsel | Block until APPROVED |
| `WORKER_LOCATION_DISCLOSURE_ES_V1` | Standard worker/project location | es-US | `DRAFT_REQUIRES_HUMAN_REVIEW` | Qualified bilingual employment/privacy counsel | Block until APPROVED |
| `GC_CUSTOM_NOTICE_TEMPLATE_EN_V1` | GC-specific notice template | en-US | `DRAFT_REQUIRES_HUMAN_REVIEW` | Licensed counsel | Block until APPROVED |
| `GC_CUSTOM_NOTICE_TEMPLATE_ES_V1` | GC-specific notice template | es-US | `DRAFT_REQUIRES_HUMAN_REVIEW` | Qualified bilingual counsel | Block until APPROVED |
| `ACCOUNT_DELETION_RETENTION_EN_V1` | Data subject notice | en-US | `DRAFT_REQUIRES_HUMAN_REVIEW` | Privacy counsel | Block until APPROVED |
| `ACCOUNT_DELETION_RETENTION_ES_V1` | Data subject notice | es-US | `DRAFT_REQUIRES_HUMAN_REVIEW` | Qualified bilingual privacy counsel | Block until APPROVED |
| `MUSTER_SAFETY_LIMITATIONS_EN_V1` | Supplemental safety limitations | en-US | `DRAFT_REQUIRES_HUMAN_REVIEW` | Safety/legal reviewer | Block until APPROVED |
| `MUSTER_SAFETY_LIMITATIONS_ES_V1` | Supplemental safety limitations | es-US | `DRAFT_REQUIRES_HUMAN_REVIEW` | Bilingual safety/legal reviewer | Block until APPROVED |

Statuses are exact enum `DRAFT_REQUIRES_HUMAN_REVIEW`, `REVIEWED`, `APPROVED`, `RETIRED`; only `APPROVED` can be published for production. At approval record `document_id`, `sha256_content`, `reviewer_id`, `reviewer_role`, `reviewed_at`, `approved_at`, `published_at`, `version`, `locale`, and legal scope in private admin record, not in this public template. Rejection returns to DRAFT with correction notes. For every material custom text change generate new document version and re-review both languages.

## Drafts currently in the repository (Milestone 05)

Seeded into `legal_notice_versions` by migration `20261104130000_m05_orientation_badges.sql` with status `DRAFT_REQUIRES_HUMAN_REVIEW`. Production refuses acceptance (`CONSENT_NOTICE_NOT_APPROVED`); development and staging show a DRAFT label. The SHA-256 is computed by the database over the stored text (the file content without its final newline) and is checked by `tests/i18n/legal-drafts.test.ts`.

| Document ID | File | Stored content SHA-256 | Status |
|---|---|---|---|
| `WORKER_LOCATION_DISCLOSURE_EN_V1` | `docs/legal/drafts/WORKER_LOCATION_DISCLOSURE_EN_V1.md` | `97c5edd0db681a158c888165050c022564c0d0d4d36599275f9f7c0810cc0dd3` | `DRAFT_REQUIRES_HUMAN_REVIEW` |
| `WORKER_LOCATION_DISCLOSURE_ES_V1` | `docs/legal/drafts/WORKER_LOCATION_DISCLOSURE_ES_V1.md` | `6c9ce509de9bf01fd699ab83c9f81e0ebf11a542ab233f77583ff5cf2d3d893d` | `DRAFT_REQUIRES_HUMAN_REVIEW` |

Approving a reviewed text means inserting it as a NEW version, or setting `review_status = 'APPROVED'` with `approved_by`/`approved_at` on the exact reviewed row, through the private operator workflow — never editing the stored text (the database forbids it).

## Muster safety copy in the app (Milestone 11)

The app's muster wording is AI-drafted UI copy in English and Spanish. It is the working text of `MUSTER_SAFETY_LIMITATIONS_EN_V1` / `MUSTER_SAFETY_LIMITATIONS_ES_V1` above: `DRAFT_REQUIRES_HUMAN_REVIEW`, and a production release stays blocked until a bilingual safety/legal reviewer approves it (CLAUDE.md release gate "unverified legal strings").

| Where it appears | Source |
|---|---|
| Alert title and body sent to phones ("Emergency muster — tap I'M SAFE" / "Reunión de emergencia — toque ESTOY A SALVO") | `musterNotificationText` in `packages/shared/src/api/muster.ts` |
| "Supplemental headcount tool, not a certified life-safety or evacuation system…" on the safety, foreman and kiosk screens | `muster.notLifeSafety` |
| Report notice "Supplemental headcount record, not a certified life-safety record" (also the shared text summary) | `muster.report.notice` |
| Worker after I'M SAFE: "That is not a physical check: go to the assembly point…" | `muster.worker.selfNote`, `muster.worker.instructions` |
| Kiosk muster mode: "A badge alone is not proof" | `muster.kioskBanner` |
| Alert permission explanation ("Alerts can be late or blocked, so always follow the site's emergency plan") | `muster.push.setupBody` |
| Alert delivery is communication only | `muster.pushNote`, `muster.report.pushLimits` |

The reviewer checks that the Spanish says the same thing as the English, that nothing implies a guaranteed or complete headcount, and that workers are told to follow the site's emergency plan. Approved wording replaces these strings in one PR, with the reviewer recorded here.

## Topics counsel must review before approval

- Clear, prominent background/Always, precise/approximate, work-site-only location use, limitations, who sees coordinates, the unavoidable local offsite geofence monitoring, worker refusal and fallback kiosk/foreman rights.
- Worker employed by subcontractor vs GC monitoring rights; notice, consent, applicable state recording/monitoring rules, labor-management/CBA and union considerations, workplace safety obligations.
- Distinction between estimated onsite hours and paid hours; no automatic payroll or contractual back-charge determination.
- Emergency contacts: purpose, scope of authorized personnel, retention, breach risk and worker correction/deletion processes.
- Muster: self report vs physical verification, supplemental—not a certified life-safety system or guaranteed complete emergency roster.
- Raw location <=24h after closed session, unresolved-session routine purge, conditional two-year attendance only with documented basis, legal hold and pseudonymization limitations.
- In-app account deletion and privacy policy data request mechanisms; Apple/Google disclosure and app store requirements.

## Mandatory verification tests

1. Staging EN and ES legal pages render with version, hash, language and specific project scope.
2. Production endpoint rejects draft ES or EN version and shows `CONSENT_NOTICE_NOT_APPROVED`.
3. GC edit creates new notice version and does not alter prior hash.
4. Material change triggers a new acceptance workflow for affected worker/project enrollments.
5. A no-phone worker receives printed/attended equivalent reviewed disclosure and supervised acknowledgment, never fabricated digital consent.
6. Translation test verifies approved human-reviewed strings, not just machine parity.

## Approval workflow for owner

Send drafted legal pages to qualified counsel outside the source repository. Enter approved document content and signed verification metadata through secure administrative workflow; do not put sensitive personal details or signatures in Git. Run legal-version integration tests, then publish both approved locale versions as an atomic rollout. Until then, development/testing may run with conspicuously labeled synthetic consent, but **public production enrollment stays blocked**.
