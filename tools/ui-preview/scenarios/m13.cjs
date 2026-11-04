// Milestone 13 UI preview against the LOCAL Supabase stack (web render, decision #52): the reviewer
// demo seeded by app_private.seed_reviewer_demo, its DEMO label on the project, the simulation
// screen before and after a simulated arrival (through the real demo-simulate Edge Function and the
// production ingest pipeline), the dashboard and map following it, and the same screen in Spanish.
// The location disclosure before the system prompt needs the native tracking SDK, so it is covered
// by Jest and the phone test checklist, not by a web render.
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
  return secret;
}

// The web render keeps neither the session nor the language across a reload: sign in again (the
// authenticator is already set up, so this time it is the verify step).
async function staffSignInAgain(page, email, secret) {
  await page.goto(base);
  await byTestId(page, 'choose-en-US').click();
  await byTestId(page, 'staff-sign-in').click();
  await byTestId(page, 'email-input').fill(email);
  // Drop the first sign-in's e-mail so the new code is the only one.
  await fetch(
    `${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
    { method: 'DELETE' },
  );
  await byTestId(page, 'send-email-code').click();
  await byTestId(page, 'email-code-input').fill(await latestEmailCode(email));
  await byTestId(page, 'verify-email-code').click();
  await byTestId(page, 'mfa-verify-input').fill(totp(secret));
  await byTestId(page, 'mfa-verify-confirm').click();
}

async function openTab(page, href) {
  await page.locator(`[href="${href}"]:visible`).first().click();
}

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await (
      await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' })
    ).newPage();
    const reviewerEmail = `reviewer.m13.${Date.now()}@example.test`;
    const secret = await staffSignIn(page, reviewerEmail);

    // The owner seeds the demo from the SQL editor (here: the local database as its owner).
    await query(
      'update app_private.demo_organizations set retired_at = now() where retired_at is null',
    );
    const [{ id: ownerId }] = await query(
      `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', $1, now(), '{}', '{}', now(), now())
       returning id`,
      [`demo.owner.m13.${Date.now()}@example.test`],
    );
    const [{ id: reviewerId }] = await query('select id from auth.users where email = $1', [
      reviewerEmail,
    ]);
    const [{ seed }] = await query('select app_private.seed_reviewer_demo($1, $2) as seed', [
      ownerId,
      reviewerId,
    ]);
    const projectId = seed.project_id;
    const first = seed.synthetic_worker_ids[0];

    // Signed in again, the reviewer holds the demo's staff roles and its worker profile.
    // The email code above is used: wait out its resend interval before asking for a new one.
    await query(
      "update auth.users set confirmation_sent_at = now() - interval '2 minutes', recovery_sent_at = now() - interval '2 minutes' where email = $1",
      [reviewerEmail],
    );
    await staffSignInAgain(page, reviewerEmail, secret);
    await byTestId(page, 'choose-context-screen').waitFor({ timeout: 20000 });
    await byTestId(page, 'as-staff').click();
    await openTab(page, '/staff/projects');
    await byTestId(page, `project-${projectId}`).click();
    await byTestId(page, 'demo-banner').waitFor({ timeout: 20000 });
    await shot(page, '01-demo-project-en');
    await shot(page, '02-demo-entry-en', 'open-demo');
    await byTestId(page, 'open-demo').click();
    await byTestId(page, `demo-worker-${first}`).waitFor({ timeout: 20000 });
    await shot(page, '03-demo-simulate-en');
    await byTestId(page, `demo-arrive-${first}`).click();
    await byTestId(page, `demo-result-${first}`).waitFor({ timeout: 20000 });
    await shot(page, '04-demo-arrived-en', `demo-worker-${first}`);

    // The dashboard and the map follow the simulated arrival, under the DEMO label.
    await page.goBack();
    await page.goBack();
    await openTab(page, '/staff/home');
    await byTestId(page, 'dash-onsite').waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    await shot(page, '05-demo-dashboard-en');
    await openTab(page, '/staff/map');
    await page.waitForTimeout(2500);
    await shot(page, '06-demo-map-en');

    // Spanish: switch the language in More, then open the simulation screen again.
    await openTab(page, '/staff/more');
    await byTestId(page, 'language-switch-es-US').click();
    await openTab(page, '/staff/projects');
    await byTestId(page, `project-${projectId}`).click();
    await byTestId(page, 'demo-banner').waitFor({ timeout: 20000 });
    await shot(page, '07-demo-project-es');
    await byTestId(page, 'open-demo').click();
    await byTestId(page, `demo-worker-${first}`).waitFor({ timeout: 20000 });
    await shot(page, '08-demo-simulate-es');
  } catch (error) {
    console.error('url:', (await error?.page?.url?.()) ?? '');
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
