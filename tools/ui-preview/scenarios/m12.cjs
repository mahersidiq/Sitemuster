// Milestone 12 UI preview against the LOCAL Supabase stack (web render, decision #52): the
// worker's location-and-consent screen (on, then off), a materially changed notice to accept
// (Spanish), in-app account deletion (the draft notice, a fresh SMS code, the last step, done) and
// signing in again while the deletion is processed (Spanish). The native share sheet, real SMS
// and push are device-only (HUMAN_CHECKLIST "Real-device privacy and account deletion check").
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

async function workerSignIn(page, locale, existing, landing = 'join-screen') {
  await page.goto(base);
  await byTestId(page, `choose-${locale}`).click();
  await byTestId(page, 'worker-sign-in').click();
  const local = existing ?? String(Math.floor(Math.random() * 9000000) + 1000000);
  await byTestId(page, 'phone-input').fill(`(555) ${local.slice(0, 3)}-${local.slice(3)}`);
  await byTestId(page, 'send-code').click();
  await byTestId(page, 'code-input').waitFor();
  const rows = await query(
    'select otp from app_private.dev_sms_outbox where phone = $1 order by id desc limit 1',
    [`1555${local}`],
  );
  await byTestId(page, 'code-input').fill(rows[0].otp);
  await byTestId(page, 'verify-code').click();
  await byTestId(page, landing).waitFor({ timeout: 20000 });
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

// The 60-second resend cooldown of the previous code (the same trick as the backend tests).
async function ageCodes(local) {
  await query(
    `update auth.users set confirmation_sent_at = confirmation_sent_at - interval '2 minutes',
            recovery_sent_at = recovery_sent_at - interval '2 minutes' where phone = $1`,
    [`1555${local}`],
  );
}

async function latestSmsCode(local) {
  const rows = await query(
    'select otp from app_private.dev_sms_outbox where phone = $1 order by id desc limit 1',
    [`1555${local}`],
  );
  return rows[0].otp;
}

async function join(page, code, name) {
  await byTestId(page, 'join-type').click();
  await byTestId(page, 'join-code-input').fill(code);
  await byTestId(page, 'join-code-submit').click();
  await byTestId(page, 'details-name').fill(name);
  await byTestId(page, 'details-company-name').fill('Southern Concrete');
  await byTestId(page, 'details-trade').fill('Concrete');
  await byTestId(page, 'details-emergency-name').fill('Luis Acosta');
  await byTestId(page, 'details-emergency-phone').fill('+1 555 000 2222');
  await byTestId(page, 'details-emergency-relationship').fill('Brother');
  await byTestId(page, 'join-next').click();
  await byTestId(page, 'notice-view').waitFor();
  await byTestId(page, 'join-acknowledge').click();
  await byTestId(page, 'join-submit').scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await byTestId(page, 'join-submit').click();
  await byTestId(page, 'join-done').waitFor();
  await byTestId(page, 'join-home').click();
  await page.locator('[data-testid^="enrollment-status-"]:visible').first().waitFor();
}

// A materially changed worker notice (EN + ES), approved by a platform operator with MFA through
// the audited operator RPC, exactly as the CLI does (synthetic preview text, decision #124).
async function approveMaterialNotice() {
  const db = new Client({ connectionString: process.env.DB_URL });
  await db.connect();
  try {
    await db.query('begin');
    const operator = (
      await db.query(
        `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', $1, now(), '{}', '{}', now(), now())
         returning id`,
        [`operator.m12.${Date.now()}@example.test`],
      )
    ).rows[0].id;
    await db.query('insert into app_private.platform_operators (user_id) values ($1)', [operator]);
    const texts = {
      'en-US':
        "SiteMuster location notice, version 2 (screenshot preview, synthetic text). While you are on this project's site, your phone may share its location with the project team to estimate attendance. Away from the site nothing is shared. You can switch location off at any time; the kiosk and your foreman can still sign you in and out.",
      'es-US':
        'Aviso de ubicación de SiteMuster, versión 2 (vista previa, texto sintético). Mientras esté en el sitio de este proyecto, su teléfono puede compartir su ubicación con el equipo del proyecto para estimar la asistencia. Fuera del sitio no se comparte nada. Puede apagar la ubicación en cualquier momento; el quiosco y su capataz todavía pueden registrar su entrada y salida.',
    };
    const ids = [];
    for (const [locale, content] of Object.entries(texts)) {
      const tag = locale === 'en-US' ? 'EN' : 'ES';
      ids.push([
        (
          await db.query(
            `insert into public.legal_notice_versions (document_id, locale, document_type, version, content, material_change)
             values ($1, $2, 'WORKER_LOCATION_DISCLOSURE', 2, $3, true) returning id`,
            [`WORKER_LOCATION_DISCLOSURE_${tag}_V2`, locale, content],
          )
        ).rows[0].id,
        content,
      ]);
    }
    await db.query(
      "select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)",
      [JSON.stringify({ sub: operator, role: 'authenticated', aal: 'aal2' })],
    );
    for (const [id, content] of ids) {
      await db.query(
        `select public.operator_approve_legal_notice($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'),
                'Preview Reviewer', 'Synthetic preview only', null, 'screenshot preview')`,
        [id, content],
      );
    }
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    await db.end();
  }
}

async function main() {
  const browser = await chromium.launch();
  try {
    const context = (locale) => browser.newContext({ viewport, deviceScaleFactor: 2, locale });
    const staff = await (await context('en-US')).newPage();
    await staffSignIn(staff, `owner.m12.${Date.now()}@example.test`);
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
    const [{ code }] = await query(
      "select 'SMS1.' || session_id || '.' || static_code as code from app_private.orientation_session_secrets order by created_at desc limit 1",
    );

    // Ana (English) and Marta (Spanish) join with the printed orientation code and are approved.
    const ana = await (await context('en-US')).newPage();
    const anaPhone = await workerSignIn(ana, 'en-US');
    await join(ana, code, 'Ana Acosta');
    const marta = await (await context('es-US')).newPage();
    await workerSignIn(marta, 'es-US');
    await join(marta, code, 'Marta Ruiz');
    await byTestId(staff, 'orientation-to-workers').click();
    await byTestId(staff, 'select-all').click();
    await byTestId(staff, 'approve-selected').click();
    await byTestId(staff, 'bulk-results').waitFor();
    const [{ project_id: projectId }] = await query(
      `select e.project_id from public.worker_enrollments e join public.worker_profiles w on w.id = e.worker_id
        where w.legal_name = 'Ana Acosta' order by e.created_at desc limit 1`,
    );

    // Ana: location on, then off for this project (the kiosk and foreman still work).
    await openTab(ana, '/worker/profile');
    await byTestId(ana, 'open-privacy').click();
    await byTestId(ana, `privacy-${projectId}`).waitFor({ timeout: 20000 });
    await shot(ana, '01-privacy-on-en');
    await byTestId(ana, `privacy-location-${projectId}`).click();
    await byTestId(ana, 'privacy-message').waitFor({ timeout: 20000 });
    await shot(ana, '02-privacy-off-en');

    // A materially changed notice: Marta must read and accept it before location resumes.
    await approveMaterialNotice();
    await openTab(marta, '/worker/profile');
    await byTestId(marta, 'open-privacy').click();
    await byTestId(marta, `privacy-renewal-${projectId}`).waitFor({ timeout: 20000 });
    await shot(marta, '03-renewal-es');

    // Ana deletes her account: the draft notice, a fresh code, the last step, done.
    await byTestId(ana, 'privacy-delete-account').click();
    await byTestId(ana, 'notice-view').waitFor({ timeout: 20000 });
    await shot(ana, '04-delete-explain-en');
    await byTestId(ana, 'delete-understand').click();
    await ageCodes(anaPhone);
    await byTestId(ana, 'delete-continue').click();
    await byTestId(ana, 'delete-verify').waitFor({ timeout: 20000 });
    await shot(ana, '05-delete-code-en');
    await byTestId(ana, 'delete-code').fill(await latestSmsCode(anaPhone));
    await byTestId(ana, 'delete-verify-button').click();
    await byTestId(ana, 'delete-confirm').waitFor({ timeout: 20000 });
    await shot(ana, '06-delete-last-step-en');
    await byTestId(ana, 'delete-now').click();
    await byTestId(ana, 'delete-done').waitFor({ timeout: 20000 });
    await shot(ana, '07-delete-done-en');
    await byTestId(ana, 'delete-finish').click();

    // Signing in again before the deletion is processed shows only that (Spanish).
    const again = await (await context('es-US')).newPage();
    await ageCodes(anaPhone);
    await workerSignIn(again, 'es-US', anaPhone, 'deletion-pending-screen');
    await shot(again, '08-deletion-pending-es');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
