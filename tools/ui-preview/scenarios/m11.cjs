// Milestone 11 UI preview against the LOCAL Supabase stack (web render, decision #52): the
// designated safety role starts a muster (real muster-start function, development push adapter),
// the worker answers I'M SAFE (EN/ES) through the outbox and ingest-operations, the board keeps
// "said safe" apart from "seen at the assembly point", the commander checks a worker without a
// phone, closes with an acknowledgement and reads the immutable report. Push delivery, the
// lock-screen I'M SAFE button and the native share sheet are device-only (HUMAN_CHECKLIST).
const { chromium } = require('playwright');
const { Buffer } = require('node:buffer');
const { createHmac } = require('node:crypto');
const path = require('node:path');

const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));

const [base, out] = process.argv.slice(2);
const viewport = { width: 390, height: 844 };
const byTestId = (page, id) => page.locator(`[data-testid="${id}"]:visible`).first();

async function shot(page, name, scrollTo) {
  if (scrollTo) await byTestId(page, scrollTo).scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`captured ${name}.png`);
}

async function query(sql, params) {
  const db = new Client({ connectionString: process.env.DB_URL });
  await db.connect();
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.end();
  }
}

async function latestEmailCode(address) {
  for (let i = 0; i < 40; i += 1) {
    const search = await (
      await fetch(
        `${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
      )
    ).json();
    if (search.messages[0]) {
      const message = await (
        await fetch(`${process.env.MAILPIT_URL}/api/v1/message/${search.messages[0].ID}`)
      ).json();
      const code = `${message.Text} ${message.HTML}`.match(/\b(\d{6})\b/);
      if (code) return code[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('no email code');
}

function totp(secretBase32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secretBase32.replace(/\s|=/g, '').toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function staffSignIn(page, email) {
  await page.goto(base);
  await byTestId(page, 'choose-en-US').click();
  await byTestId(page, 'staff-sign-in').click();
  await byTestId(page, 'email-input').fill(email);
  await byTestId(page, 'send-email-code').click();
  await byTestId(page, 'email-code-input').fill(await latestEmailCode(email));
  await byTestId(page, 'verify-email-code').click();
  await byTestId(page, 'mfa-secret').waitFor();
  const secret = await byTestId(page, 'mfa-secret').innerText();
  await byTestId(page, 'mfa-code-input').fill(totp(secret));
  await byTestId(page, 'mfa-confirm').click();
  await byTestId(page, 'no-org-screen').waitFor();
}

async function workerSignIn(page, locale) {
  await page.goto(base);
  await byTestId(page, `choose-${locale}`).click();
  await byTestId(page, 'worker-sign-in').click();
  const local = String(Math.floor(Math.random() * 9000000) + 1000000);
  await byTestId(page, 'phone-input').fill(`(555) ${local.slice(0, 3)}-${local.slice(3)}`);
  await byTestId(page, 'send-code').click();
  await byTestId(page, 'code-input').waitFor();
  const rows = await query(
    'select otp from app_private.dev_sms_outbox where phone = $1 order by id desc limit 1',
    [`1555${local}`],
  );
  await byTestId(page, 'code-input').fill(rows[0].otp);
  await byTestId(page, 'verify-code').click();
  await byTestId(page, 'join-screen').waitFor();
  return local;
}

async function openTab(page, href) {
  await page
    .locator(`[href="${href}"]:visible`)
    .first()
    .click()
    .catch(async (error) => {
      await page.screenshot({ path: `${out}/debug-tab.png` });
      console.error('url:', page.url(), (await page.locator('body').innerText()).slice(0, 600));
      throw error;
    });
}

async function main() {
  const browser = await chromium.launch();
  try {
    const staffContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      locale: 'en-US',
    });
    const staff = await staffContext.newPage();
    const ownerEmail = `owner.m11.${Date.now()}@example.test`;
    await staffSignIn(staff, ownerEmail);
    await byTestId(staff, 'create-organization').click();
    await byTestId(staff, 'org-name').fill('Gulf Coast Builders');
    await byTestId(staff, 'org-create').click();
    await byTestId(staff, 'new-project').click();
    await byTestId(staff, 'project-name').fill('Main Street Tower');
    await byTestId(staff, 'wizard-next').click();
    await byTestId(staff, 'address-query').fill('100 Main St');
    await byTestId(staff, 'address-candidate-0').click();
    await byTestId(staff, 'selected-address').waitFor();
    await byTestId(staff, 'wizard-next').click();
    await byTestId(staff, 'timezone-America/Chicago').click();
    await byTestId(staff, 'wizard-next').click();
    await byTestId(staff, 'wizard-create').click();
    await byTestId(staff, 'status-ACTIVE').click();
    await byTestId(staff, 'confirm-status').click();
    await byTestId(staff, 'run-orientation').click();
    await byTestId(staff, 'orientation-start').click();
    await byTestId(staff, 'orientation-rotating-qr').waitFor();

    // Ana joins with the orientation code, is approved and is her company's verified foreman.
    const workerContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      locale: 'en-US',
    });
    const worker = await workerContext.newPage();
    await workerSignIn(worker, 'en-US');
    const [{ code }] = await query(
      "select 'SMS1.' || session_id || '.' || static_code as code from app_private.orientation_session_secrets order by created_at desc limit 1",
    );
    await byTestId(worker, 'join-type').click();
    await byTestId(worker, 'join-code-input').fill(code);
    await byTestId(worker, 'join-code-submit').click();
    await byTestId(worker, 'details-name').fill('Ana Acosta');
    await byTestId(worker, 'details-company-name').fill('Southern Concrete');
    await byTestId(worker, 'details-trade').fill('Concrete');
    await byTestId(worker, 'details-emergency-name').fill('Luis Acosta');
    await byTestId(worker, 'details-emergency-phone').fill('+1 555 000 2222');
    await byTestId(worker, 'details-emergency-relationship').fill('Brother');
    await byTestId(worker, 'join-next').click();
    await byTestId(worker, 'notice-view').waitFor();
    await byTestId(worker, 'join-acknowledge').click();
    await byTestId(worker, 'join-submit').scrollIntoViewIfNeeded();
    await worker.waitForTimeout(700);
    await byTestId(worker, 'join-submit').click();
    await byTestId(worker, 'join-done').waitFor();
    await byTestId(worker, 'join-home').click();
    await worker.locator('[data-testid^="enrollment-status-"]:visible').first().waitFor();
    await byTestId(staff, 'orientation-to-workers').click();
    await byTestId(staff, 'select-all').click();
    await byTestId(staff, 'approve-selected').click();
    await byTestId(staff, 'bulk-results').waitFor();

    const [{ project_id: projectId, company_id: companyId }] = await query(
      `select p.id as project_id, e.subcontractor_id as company_id
         from public.projects p join public.organizations o on o.id = p.organization_id
         join auth.users u on u.id = o.owner_user_id and u.email = $1
         join public.worker_enrollments e on e.project_id = p.id
        order by p.created_at desc limit 1`,
      [ownerEmail],
    );
    await query(
      "update public.worker_enrollments set employer_status = 'VERIFIED', employer_confirmed_at = now() where project_id = $1",
      [projectId],
    );
    // Ben has no phone (managed identity); Vera is signed in at the visitor desk.
    await query(
      `with w as (insert into public.worker_profiles (legal_name, managed_identity) values ('Ben Avila', true) returning id),
            n as (select id from public.legal_notice_versions where document_id = 'WORKER_LOCATION_DISCLOSURE_EN_V1'),
            o as (insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id)
                  select w.id, $1, now(), n.id from w, n returning worker_profile_id)
       insert into public.worker_enrollments (project_id, worker_id, subcontractor_id, trade, enrollment_status, employer_status, employer_confirmed_at, approval_at)
       select $1, o.worker_profile_id, $2, 'Concrete', 'APPROVED', 'VERIFIED', now(), now() from o`,
      [projectId, companyId],
    );
    await query(
      `with v as (insert into public.visitor_records (project_id, name, organization, purpose)
                  values ($1, 'Vera Inspector', 'City Inspections', 'Inspection') returning id)
       insert into public.visitor_visits (visitor_id, project_id, checked_in_at, idempotency_key)
       select v.id, $1, now() - interval '1 hour', gen_random_uuid() from v`,
      [projectId],
    );
    // The owner is this project's designated emergency contact (decision #53).
    await query(
      `with u as (select id from auth.users where email = $2),
            upd as (update public.project_staff s set emergency_designated = true from u
                     where s.project_id = $1 and s.user_id = u.id and s.status = 'ACTIVE' returning s.id)
       insert into public.project_staff (project_id, user_id, role, emergency_designated)
       select $1, u.id, 'SAFETY', true from u where not exists (select 1 from upd)`,
      [projectId, ownerEmail],
    );

    // Commander: Muster -> Start (with a confirmation). The preview server has no deep links.
    await staff.goBack();
    await staff.goBack();
    await byTestId(staff, 'open-muster').click();
    await byTestId(staff, 'muster-label').waitFor({ timeout: 20000 });
    await byTestId(staff, 'muster-label').fill('Fire alarm drill');
    await byTestId(staff, 'muster-start-button').click();
    await byTestId(staff, 'muster-start-confirm-card').waitFor();
    await shot(staff, '01-start-confirm-en', 'muster-start');
    await byTestId(staff, 'muster-start-confirm').click();
    await byTestId(staff, 'muster-counts').waitFor({ timeout: 20000 });
    await shot(staff, '02-board-started-en');

    // Worker Ana: the muster card with I'M SAFE (English, then Spanish), then her answer.
    await openTab(worker, '/worker/projects');
    await openTab(worker, '/worker/home');
    await worker
      .locator('[data-testid^="muster-alert-"]:visible')
      .first()
      .waitFor({ timeout: 20000 });
    await shot(worker, '03-worker-im-safe-en');
    await openTab(worker, '/worker/profile');
    await byTestId(worker, 'language-switch-es-US').click();
    await openTab(worker, '/worker/home');
    await worker.getByText('ESTOY A SALVO', { exact: true }).first().waitFor({ timeout: 20000 });
    await shot(worker, '04-worker-im-safe-es');
    await byTestId(worker, 'muster-im-safe').click();
    await byTestId(worker, 'muster-self-note').waitFor({ timeout: 20000 });
    await worker.getByText('Registrado', { exact: true }).first().waitFor({ timeout: 20000 });
    await shot(worker, '05-worker-self-report-es');

    // Commander: Ana "said safe (not checked)"; Ben (no phone) is checked at the assembly point.
    await staff
      .getByText('Said safe (not checked)', { exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    const [{ ben }] = await query(
      `select m.id as ben from public.muster_snapshot_members m
         join public.worker_profiles w on w.id = m.worker_id
        where w.legal_name = 'Ben Avila' order by m.id desc limit 1`,
    );
    await byTestId(staff, `muster-seen-${ben}`).click();
    await staff
      .getByText('Seen at the assembly point: 1', { exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    await shot(staff, '06-board-separated-en', 'muster-counts');
    await byTestId(staff, 'muster-board-filter-ALL').click();
    await shot(staff, '07-board-people-en', 'muster-board-people');

    // Close: unresolved people need an explicit acknowledgement and a note.
    await byTestId(staff, 'muster-close-open').click();
    await byTestId(staff, 'muster-close-note').fill(
      'Drill ended. Vera (visitor) left before the count.',
    );
    await byTestId(staff, 'muster-close-ack').click();
    await shot(staff, '08-close-en', 'muster-close');
    await byTestId(staff, 'muster-close-confirm').click();
    await byTestId(staff, 'muster-report-notice').waitFor({ timeout: 20000 });
    await shot(staff, '09-report-en');
    await shot(staff, '10-report-people-en', 'muster-report-members');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
