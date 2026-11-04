// Milestone 05 UI preview against the LOCAL Supabase stack (web render, decision #52):
// staff runs orientation (live + printable QR) → worker joins in Spanish (draft notice) and waits →
// staff approves (result per person) → worker opens the offline badge → staff adds a no-phone
// worker and issues a printed badge. Codes come from the local dev SMS outbox / Mailpit / database.
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
  await page.waitForTimeout(700);
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

async function workerSignIn(page) {
  await page.goto(base);
  await byTestId(page, 'choose-es-US').click();
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
}

async function openTab(page, href) {
  await page.locator(`[href="${href}"]:visible`).first().click();
}

async function main() {
  const browser = await chromium.launch();
  try {
    const ownerEmail = `owner.m05.${Date.now()}@example.test`;
    const staff = await (
      await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' })
    ).newPage();
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
    await shot(staff, '01-orientation-live-en');
    await byTestId(staff, 'orientation-mode-PRINTED').click();
    await byTestId(staff, 'orientation-printed-qr').waitFor();
    await shot(staff, '02-orientation-printable-en');

    // Worker (Spanish) joins with the printed code.
    const worker = await (
      await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'es-MX' })
    ).newPage();
    await workerSignIn(worker);
    await shot(worker, '03-join-es');
    const [{ code }] = await query(
      "select 'SMS1.' || session_id || '.' || static_code as code from app_private.orientation_session_secrets order by created_at desc limit 1",
    );
    await byTestId(worker, 'join-type').click();
    await byTestId(worker, 'join-code-input').fill(code);
    await byTestId(worker, 'join-code-submit').click();
    await byTestId(worker, 'details-name').fill('Ana Trabajadora');
    await byTestId(worker, 'details-company-name').fill('Concretos del Sur');
    await byTestId(worker, 'details-trade').fill('Concreto');
    await byTestId(worker, 'details-emergency-name').fill('Luis Trabajador');
    await byTestId(worker, 'details-emergency-phone').fill('+1 555 000 2222');
    await byTestId(worker, 'details-emergency-relationship').fill('Hermano');
    await shot(worker, '04-join-details-es');
    await byTestId(worker, 'join-next').click();
    await byTestId(worker, 'notice-view').waitFor();
    await shot(worker, '05-join-notice-es');
    await byTestId(worker, 'join-acknowledge').click();
    await shot(worker, '06-join-accept-es', 'join-submit');
    await byTestId(worker, 'join-submit').click();
    await byTestId(worker, 'join-done').waitFor();
    await shot(worker, '07-join-done-es');
    await byTestId(worker, 'join-home').click();
    await worker.locator('[data-testid^="enrollment-status-"]:visible').first().waitFor();
    await shot(worker, '08-worker-pending-es');

    // Staff approves; one result per person.
    await byTestId(staff, 'orientation-to-workers').click();
    await byTestId(staff, 'select-all').click();
    await shot(staff, '09-approvals-pending-en');
    await byTestId(staff, 'approve-selected').click();
    await byTestId(staff, 'bulk-results').waitFor();
    await shot(staff, '10-approval-results-en');

    // Worker: badge after approval (computed on the phone, works offline).
    await openTab(worker, '/worker/projects');
    await openTab(worker, '/worker/home');
    await worker.locator('[data-testid^="show-badge-"]:visible').first().click();
    await byTestId(worker, 'badge-activate').click();
    await byTestId(worker, 'badge-qr').waitFor();
    await shot(worker, '11-badge-es');

    // Staff: supervised no-phone worker and a printed badge.
    await byTestId(staff, 'add-no-phone').click();
    await byTestId(staff, 'details-name').fill('Pedro Sin Teléfono');
    await staff.locator('[data-testid^="details-company-"]:visible').first().click();
    await byTestId(staff, 'details-emergency-name').fill('María');
    await byTestId(staff, 'details-emergency-phone').fill('+1 555 000 3333');
    await byTestId(staff, 'notice-view').waitFor();
    await shot(staff, '12-add-no-phone-worker-en', 'add-worker-ack');
    await byTestId(staff, 'add-worker-ack').click();
    await byTestId(staff, 'add-worker-submit').click();
    await byTestId(staff, 'add-worker-done').waitFor();
    await byTestId(staff, 'add-worker-back').click();
    await staff.locator('[data-testid^="printed-"]:visible').first().click();
    await byTestId(staff, 'printed-badge-issue').click();
    await byTestId(staff, 'printed-badge-qr').waitFor();
    await shot(staff, '13-printed-badge-en');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
