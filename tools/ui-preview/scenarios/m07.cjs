// Milestone 07 UI preview against the LOCAL Supabase stack (web render, decision #52):
// an approved worker with an accepted notice sets up the phone, then sees automatic attendance on
// the home card and the details screen (EN), the permission-required state, and Spanish.
// The location SDK is an inert web stand-in: this proves layout and copy, never native tracking.
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
    const staff = await (
      await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' })
    ).newPage();
    await staffSignIn(staff, `owner.m07.${Date.now()}@example.test`);
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

    const worker = await (
      await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' })
    ).newPage();
    worker.on('response', async (response) => {
      if (response.url().includes('complete_orientation') && response.status() >= 400) {
        console.error('complete_orientation error:', (await response.text()).slice(0, 400));
      }
    });
    await workerSignIn(worker, 'en-US');
    const [{ code }] = await query(
      "select 'SMS1.' || session_id || '.' || static_code as code from app_private.orientation_session_secrets order by created_at desc limit 1",
    );
    await byTestId(worker, 'join-type').click();
    await byTestId(worker, 'join-code-input').fill(code);
    await byTestId(worker, 'join-code-submit').click();
    await byTestId(worker, 'details-name').fill('Ana Worker');
    await byTestId(worker, 'details-company-name').fill('Southern Concrete');
    await byTestId(worker, 'details-trade').fill('Concrete');
    await byTestId(worker, 'details-emergency-name').fill('Luis Worker');
    await byTestId(worker, 'details-emergency-phone').fill('+1 555 000 2222');
    await byTestId(worker, 'details-emergency-relationship').fill('Brother');
    await byTestId(worker, 'join-next').click();
    await byTestId(worker, 'notice-view').waitFor();
    await byTestId(worker, 'join-acknowledge').click();
    await byTestId(worker, 'join-submit').scrollIntoViewIfNeeded();
    await worker.waitForTimeout(700); // let the acknowledgement enable the button
    await byTestId(worker, 'join-submit').click();
    await byTestId(worker, 'join-done')
      .waitFor()
      .catch(async (error) => {
        await worker.screenshot({ path: `${out}/debug-join.png`, fullPage: true });
        console.error((await worker.locator('body').innerText()).slice(-900));
        throw error;
      });

    // Worker goes home and waits; staff approves through the app; the employer is confirmed.
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

    // Worker sets up the phone from the badge, then opens automatic attendance.
    await openTab(worker, '/worker/projects');
    await openTab(worker, '/worker/home');
    await worker.locator('[data-testid^="show-badge-"]:visible').first().click();
    await byTestId(worker, 'badge-activate').click();
    await byTestId(worker, 'badge-qr').waitFor();
    await byTestId(worker, 'badge-back').click();
    await byTestId(worker, 'tracking-card').waitFor();
    await worker.getByText('On. Your phone notes', { exact: false }).first().waitFor();
    await shot(worker, '01-home-tracking-card-en');
    await byTestId(worker, 'tracking-card').click();
    await byTestId(worker, 'tracking-screen')
      .waitFor()
      .catch(async (error) => {
        await worker.screenshot({ path: `${out}/debug-card.png` });
        console.error(
          'url:',
          worker.url(),
          (await worker.locator('body').innerText()).slice(0, 500),
        );
        throw error;
      });
    await shot(worker, '02-tracking-active-en');
    await shot(worker, '03-tracking-sync-sites-en', 'tracking-monitored');

    // Permission-required state, in Spanish: the preview stand-in now reports "While Using"
    // without Precise; opening the details screen re-reads permissions (refresh on open).
    await worker.evaluate(() => {
      window.__previewPermission = 'whenInUse';
    });
    await byTestId(worker, 'tracking-back').click();
    await openTab(worker, '/worker/profile');
    await byTestId(worker, 'language-switch-es-US').click();
    await openTab(worker, '/worker/home');
    await byTestId(worker, 'tracking-card').click();
    await byTestId(worker, 'tracking-allow').waitFor();
    await shot(worker, '05-tracking-permission-required-es', 'tracking-permissions');
    await byTestId(worker, 'tracking-back').click();
    await worker.getByText('Necesita permiso de ubicación', { exact: false }).first().waitFor();
    await shot(worker, '04-home-permission-required-es');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
