// Milestone 08 UI preview against the LOCAL Supabase stack (web render, decision #52): the
// attended kiosk (offline "waiting to sync", then the real ingest-operations answer), a printed
// badge confirmation, the visitor desk, a manual correction, the foreman crew screen (Spanish) and
// sign-out with unsent records. Camera scanning is replaced by the typed-code field on the web.
const { chromium } = require('playwright');
const { Buffer } = require('node:buffer');
const { createDecipheriv, createHash, createHmac } = require('node:crypto');
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

const DEV_BADGE_KEY = createHash('sha256')
  .update('sitemuster-development-only-badge-secret-key-v1')
  .digest();
const b64url = (buffer) =>
  Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The worker phone's current 30-second badge code (local stack: development badge key). */
async function phoneBadge(projectId) {
  const [row] = await query(
    `select d.id as device_id, s.secret_ciphertext from public.device_installations d
       join app_private.device_badge_secrets s on s.device_id = d.id
      where d.active order by d.created_at desc limit 1`,
  );
  const blob = row.secret_ciphertext;
  const decipher = createDecipheriv('aes-256-gcm', DEV_BADGE_KEY, blob.subarray(0, 12));
  decipher.setAAD(Buffer.from(`SMBS1|${row.device_id}`));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  const secret = Buffer.concat([
    decipher.update(blob.subarray(12, blob.length - 16)),
    decipher.final(),
  ]);
  const step = Math.floor(Date.now() / 30000);
  const mac = b64url(
    createHmac('sha256', secret).update(`SMB1|${row.device_id}|${projectId}|${step}`).digest(),
  ).slice(0, 22);
  return `SMB1.${row.device_id}.${projectId}.${step}.${mac}`;
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
    const ownerEmail = `owner.m08.${Date.now()}@example.test`;
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

    // A worker joins, is approved (employer confirmed) and sets up the phone.
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
    await query(
      `update public.worker_enrollments set employer_status = 'VERIFIED', employer_confirmed_at = now()
        where enrollment_status = 'APPROVED' and employer_status <> 'VERIFIED'`,
    );
    await openTab(worker, '/worker/projects');
    await openTab(worker, '/worker/home');
    await worker.locator('[data-testid^="show-badge-"]:visible').first().click();
    await byTestId(worker, 'badge-activate').click();
    await byTestId(worker, 'badge-qr').waitFor();
    await byTestId(worker, 'badge-back').click();

    // Seed: the owner is also the project's kiosk attendant; a no-phone worker with a printed
    // badge; the worker is the foreman of their company (verified).
    const [{ project_id: projectId, user_id: ownerId, company_id: companyId }] = await query(
      `select p.id as project_id, u.id as user_id, e.subcontractor_id as company_id
         from public.projects p join auth.users u on u.email = $1
         join public.worker_enrollments e on e.project_id = p.id
        where p.name = 'Main Street Tower' order by p.created_at desc limit 1`,
      [ownerEmail],
    );
    await query(
      "insert into public.project_staff (project_id, user_id, role, emergency_designated) values ($1, $2, 'ATTENDANT', false)",
      [projectId, ownerId],
    );
    const printedCode = `SMP1.mainstreet-diego-${Date.now()}`;
    await query(
      `with w as (insert into public.worker_profiles (legal_name, managed_identity) values ('Diego Ruiz', true) returning id),
            n as (select id from public.legal_notice_versions where document_id = 'WORKER_LOCATION_DISCLOSURE_EN_V1'),
            o as (insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id)
                  select w.id, $1, now(), n.id from w, n returning worker_profile_id),
            e as (insert into public.worker_enrollments (project_id, worker_id, subcontractor_id, trade, enrollment_status, employer_status, employer_confirmed_at, approval_at)
                  select $1, o.worker_profile_id, $2, 'Concrete', 'APPROVED', 'VERIFIED', now(), now() from o returning worker_id),
            c as (insert into public.tracking_consents (worker_id, project_id, notice_version_id, locale, method, accepted_at)
                  select e.worker_id, $1, n.id, 'en-US', 'SUPERVISED', now() from e, n returning worker_id),
            m as (insert into public.subcontractor_members (company_id, worker_profile_id, role, verification_status)
                  select $2, c.worker_id, 'WORKER', 'VERIFIED' from c returning worker_profile_id)
       insert into public.worker_badges (worker_id, badge_kind, opaque_badge_hash)
       select m.worker_profile_id, 'PRINTED', sha256(convert_to($3, 'UTF8')) from m`,
      [projectId, companyId, printedCode],
    );
    await query(
      "update public.project_subcontractors set status = 'APPROVED' where project_id = $1 and subcontractor_id = $2",
      [projectId, companyId],
    );
    await query(
      `insert into public.subcontractor_members (company_id, worker_profile_id, role, verification_status)
       select $1, e.worker_id, 'FOREMAN', 'VERIFIED' from public.worker_enrollments e
         join public.worker_profiles w on w.id = e.worker_id
        where e.project_id = $2 and w.legal_name = 'Ana Acosta'`,
      [companyId, projectId],
    );

    // Kiosk: offline first (the phone keeps the scan), then back online. In-app navigation only:
    // a page load would drop the preview's in-memory session.
    await staff.goBack();
    await staff.goBack();
    await byTestId(staff, 'open-kiosk').click();
    await byTestId(staff, 'kiosk').waitFor();
    await shot(staff, '01-kiosk-ready-en');
    await staffContext.setOffline(true);
    await byTestId(staff, 'kiosk-code').fill(await phoneBadge(projectId));
    await byTestId(staff, 'kiosk-record').click();
    await staff.getByText('Waiting to sync', { exact: false }).first().waitFor();
    await shot(staff, '02-kiosk-offline-waiting-en', 'sync-status');
    await staffContext.setOffline(false);
    await byTestId(staff, 'sync-status-now').click();
    await staff.getByText('Ana Acosta: recorded', { exact: false }).first().waitFor();
    await shot(staff, '03-kiosk-synced-recorded-en', 'kiosk-recent');
    await byTestId(staff, 'kiosk-code').fill(printedCode);
    await byTestId(staff, 'kiosk-record').click();
    await byTestId(staff, 'kiosk-printed').waitFor();
    await shot(staff, '04-kiosk-printed-confirm-en', 'kiosk-printed');
    await byTestId(staff, 'kiosk-printed-confirm').click();
    await staff
      .getByText('Diego Ruiz: recorded', { exact: false })
      .first()
      .waitFor()
      .catch(async (error) => {
        await staff.screenshot({ path: `${out}/debug-diego.png`, fullPage: true });
        console.error((await staff.locator('body').innerText()).slice(-1200));
        throw error;
      });

    // Visitor desk.
    await byTestId(staff, 'kiosk-visitors').click();
    await byTestId(staff, 'visitor-name').fill('Ivy Inspector');
    await byTestId(staff, 'visitor-organization').fill('City of Houston');
    await byTestId(staff, 'visitor-purpose').fill('Framing inspection');
    await staff.locator('[data-testid="visitor-host"] [role="radio"]:visible').first().click();
    await byTestId(staff, 'visitor-submit').click();
    await byTestId(staff, 'visitors-on-site')
      .getByText('Ivy Inspector', { exact: false })
      .first()
      .waitFor();
    await byTestId(staff, 'visitor-results').waitFor();
    await shot(staff, '05-visitors-on-site-en', 'visitors-on-site');

    // Manual correction of Ana's visit (the kiosk opened it).
    await byTestId(staff, 'visitors-back').click();
    await byTestId(staff, 'kiosk-back').click();
    await byTestId(staff, 'open-workers').click();
    await staff.locator('[data-testid^="correct-"]:visible').first().click();
    await byTestId(staff, 'correct-screen').waitFor();
    await staff.locator('[data-testid="correct-target"] [role="radio"]:visible').first().click();
    await byTestId(staff, 'correct-reason').fill(
      'Signed the paper sheet at 06:30 before the kiosk opened',
    );
    await shot(staff, '06-correction-form-en', 'correct-form');

    // The foreman's crew screen, in Spanish.
    await openTab(worker, '/worker/profile');
    await byTestId(worker, 'language-switch-es-US').click();
    await openTab(worker, '/worker/home');
    await worker.locator('[data-testid^="crew-open-"]:visible').first().click();
    await byTestId(worker, 'crew-screen').waitFor();
    await byTestId(worker, 'crew-select-all').click();
    await byTestId(worker, 'crew-submit').click();
    await worker.locator('[data-testid^="crew-child-"]:visible').first().waitFor();
    await shot(worker, '07-crew-results-es', 'crew-results');

    // Sign-out with a record that has not reached the server. (The web build loads each route's
    // code on first visit, so More is opened once while online; native bundles everything.)
    await byTestId(staff, 'correct-back').click();
    await byTestId(staff, 'workers-screen').waitFor();
    await staff.goBack();
    await byTestId(staff, 'project-back').click();
    await openTab(staff, '/staff/more');
    await byTestId(staff, 'sign-out').waitFor();
    await openTab(staff, '/staff/projects');
    await byTestId(staff, `project-${projectId}`).click();
    await byTestId(staff, 'open-kiosk').click();
    await byTestId(staff, 'kiosk').waitFor();
    await staffContext.setOffline(true);
    await byTestId(staff, 'kiosk-direction').locator('[role="radio"]').nth(1).click();
    await byTestId(staff, 'kiosk-code').fill(`SMP1.mainstreet-spare-${Date.now()}`);
    await byTestId(staff, 'kiosk-record').click();
    await byTestId(staff, 'kiosk-printed-confirm').click();
    await staff.getByText('Waiting to sync', { exact: false }).first().waitFor();
    await byTestId(staff, 'kiosk-back').click();
    await byTestId(staff, 'project-back').click();
    await openTab(staff, '/staff/more');
    await byTestId(staff, 'sign-out').click();
    await byTestId(staff, 'sign-out-guard').waitFor();
    await shot(staff, '08-sign-out-unsent-guard-en', 'sign-out-guard');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
