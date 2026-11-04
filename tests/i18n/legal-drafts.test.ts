import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { readRepoFile } from '../support/repo';

/**
 * The draft disclosures in docs/legal/drafts are exactly what the M05 migration stores, and the
 * hashes listed in TRANSLATION_REVIEW.md match. Drafts stay marked as requiring human review.
 */
const MIGRATION = readRepoFile('supabase/migrations/20261104130000_m05_orientation_badges.sql');
const REVIEW = readRepoFile('docs/legal/TRANSLATION_REVIEW.md');
const QUOTE = '$' + 'notice' + '$';

describe.each(['EN', 'ES'])('WORKER_LOCATION_DISCLOSURE_%s_V1 draft', (lang) => {
  const file = `docs/legal/drafts/WORKER_LOCATION_DISCLOSURE_${lang}_V1.md`;
  const text = readRepoFile(file).replace(/\n+$/, '');

  it('is stored verbatim by the migration and marked as a draft', () => {
    expect(MIGRATION).toContain(`${QUOTE}${text}${QUOTE}`);
    expect(text.split('\n')[0]).toMatch(/^(DRAFT|BORRADOR) — /);
  });

  it('has its stored-content hash recorded in the review registry', () => {
    const hash = createHash('sha256').update(text, 'utf8').digest('hex');
    expect(REVIEW).toContain(
      `| \`WORKER_LOCATION_DISCLOSURE_${lang}_V1\` | \`${file}\` | \`${hash}\` | \`DRAFT_REQUIRES_HUMAN_REVIEW\` |`,
    );
  });
});
