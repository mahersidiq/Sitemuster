// Milestone 03 UI preview against the LOCAL Supabase stack: worker SMS sign-in (EN) and staff
// email code + authenticator enrollment (ES). Codes come from the local dev SMS outbox / Mailpit.
const { chromium } = require('playwright');
const { Buffer } = require('node:buffer');
const { createHmac } = require('node:crypto');
const path = require('node:path');

const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));

const [base, out] = process.argv.slice(2);
const viewport = { width: 390, height: 844 };
const byTestId = (page, id) => page.locator(`[data-testid="${id}"]`).first();

async function shot(page, name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`captured ${name}.png`);
}

async function latestSmsCode(phoneDigits) {
  const db = new Client({ connectionString: process.env.DB_URL });
  await db.connect();
  try {
    const result = await db.query(
      'select otp from app_private.dev_sms_outbox where phone = $1 order by id desc limit 1',
      [phoneDigits],
    );
    return result.rows[0].otp;
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

async function main() {
  const browser = await chromium.launch();
  try {
    // Worker (English): phone → wrong code → right code → join screen.
    const en = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' });
    const p1 = await en.newPage();
    await p1.goto(base);
    await byTestId(p1, 'choose-en-US').click();
    await byTestId(p1, 'sign-in-screen').waitFor();
    await shot(p1, '01-sign-in-en');
    await byTestId(p1, 'worker-sign-in').click();
    await byTestId(p1, 'phone-screen').waitFor();
    await byTestId(p1, 'phone-input').fill('123');
    await byTestId(p1, 'send-code').click();
    await byTestId(p1, 'phone-input-error').waitFor();
    await shot(p1, '02-phone-invalid-en');
    const local = String(Math.floor(Math.random() * 9000000) + 1000000);
    await byTestId(p1, 'phone-input').fill(`(555) ${local.slice(0, 3)}-${local.slice(3)}`);
    await byTestId(p1, 'send-code').click();
    await byTestId(p1, 'phone-code-screen').waitFor();
    await shot(p1, '03-code-sent-en');
    await byTestId(p1, 'code-input').fill('000000');
    await byTestId(p1, 'verify-code').click();
    await byTestId(p1, 'code-input-error').waitFor();
    await shot(p1, '04-code-wrong-en');
    await byTestId(p1, 'code-input').fill(await latestSmsCode(`1555${local}`));
    await byTestId(p1, 'verify-code').click();
    await byTestId(p1, 'join-screen').waitFor();
    await shot(p1, '05-worker-signed-in-join-en');

    // Staff (Spanish): email code → authenticator enrollment → verified (no organization yet).
    const es = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'es-MX' });
    const p2 = await es.newPage();
    await p2.goto(base);
    await byTestId(p2, 'choose-es-US').click();
    await byTestId(p2, 'sign-in-screen').waitFor();
    await shot(p2, '06-sign-in-es');
    await byTestId(p2, 'staff-sign-in').click();
    await byTestId(p2, 'email-screen').waitFor();
    const email = `super.${Date.now()}@example.test`;
    await byTestId(p2, 'email-input').fill(email);
    await shot(p2, '07-staff-email-es');
    await byTestId(p2, 'send-email-code').click();
    await byTestId(p2, 'email-code-screen').waitFor();
    await shot(p2, '08-staff-email-code-es');
    await byTestId(p2, 'email-code-input').fill(await latestEmailCode(email));
    await byTestId(p2, 'verify-email-code').click();
    await byTestId(p2, 'mfa-secret').waitFor();
    await shot(p2, '09-mfa-enroll-es');
    const secret = await byTestId(p2, 'mfa-secret').innerText();
    await byTestId(p2, 'mfa-code-input').fill(totp(secret));
    await byTestId(p2, 'mfa-confirm').click();
    await byTestId(p2, 'no-org-screen').waitFor();
    await shot(p2, '10-staff-verified-no-org-es');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
