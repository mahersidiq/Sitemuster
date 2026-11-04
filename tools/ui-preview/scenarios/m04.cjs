// Milestone 04 UI preview against the LOCAL Supabase stack (web render, decision #52):
// organization → new-project wizard (address via the local Edge Function's development adapter,
// site circle, time zone, overnight shift) → overlap warning → detail → sensitive config change
// (v2) → staff invitation (EN); invitee accepts and views the project (ES).
const { chromium } = require('playwright');
const { Buffer } = require('node:buffer');
const { createHmac } = require('node:crypto');

const [base, out] = process.argv.slice(2);
const viewport = { width: 390, height: 844 };
const byTestId = (page, id) => page.locator(`[data-testid="${id}"]:visible`).first();

async function shot(page, name, scrollTo) {
  if (scrollTo) await byTestId(page, scrollTo).scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`captured ${name}.png`);
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

async function staffSignIn(page, locale, email) {
  await page.goto(base);
  await byTestId(page, `choose-${locale}`).click();
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

async function openTab(page, href, label) {
  const link = page.locator(`[href="${href}"]:visible`).first();
  if (await link.count()) {
    await link.click();
    return;
  }
  const html = await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"], a[href], [role="button"]')]
      .map(
        (el) =>
          `${el.tagName} ${el.getAttribute('role')} ${el.getAttribute('href')} ${el.textContent}`,
      )
      .slice(-12)
      .join('\n'),
  );
  console.log(`[m04] no tab link for ${href}; candidates:\n${html}`);
  await page.getByRole('tab', { name: label }).first().click();
}

async function wizardToReview(page, name) {
  await byTestId(page, 'new-project').click();
  await byTestId(page, 'project-name').fill(name);
  await byTestId(page, 'wizard-next').click();
  await byTestId(page, 'address-query').fill('100 Main St');
  await byTestId(page, 'address-candidate-0').waitFor();
}

async function main() {
  const browser = await chromium.launch();
  try {
    const stamp = Date.now();
    const ownerEmail = `owner.${stamp}@example.test`;
    const inviteeEmail = `super.${stamp}@example.test`;

    // Owner (English).
    const en = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' });
    const p1 = await en.newPage();
    await staffSignIn(p1, 'en-US', ownerEmail);
    await shot(p1, '01-no-org-en');
    await byTestId(p1, 'create-organization').click();
    await byTestId(p1, 'org-name').fill('Gulf Coast Builders');
    await shot(p1, '02-create-organization-en');
    await byTestId(p1, 'org-create').click();
    await byTestId(p1, 'projects-empty').waitFor();
    await shot(p1, '03-projects-empty-en');

    await byTestId(p1, 'new-project').click();
    await byTestId(p1, 'project-name').fill('Main Street Tower');
    await byTestId(p1, 'project-number').fill('MST-1');
    await shot(p1, '04-wizard-name-en');
    await byTestId(p1, 'wizard-next').click();
    await byTestId(p1, 'address-query').fill('100 Main St');
    await byTestId(p1, 'address-candidate-0').waitFor();
    await shot(p1, '05-wizard-address-search-en');
    await byTestId(p1, 'address-candidate-0').click();
    await byTestId(p1, 'selected-address').waitFor();
    await byTestId(p1, 'radius-preset-250').click();
    await shot(p1, '06-wizard-site-circle-en', 'site-map');
    await shot(p1, '07-wizard-radius-en', 'radius-value');
    await byTestId(p1, 'wizard-next').click();
    await byTestId(p1, 'timezone-America/Chicago').click();
    await byTestId(p1, 'add-shift').click();
    await shot(p1, '08-wizard-timezone-en');
    await shot(p1, '09-wizard-shifts-en', 'shift-1');
    await byTestId(p1, 'wizard-next').click();
    await byTestId(p1, 'review-summary').waitFor();
    await shot(p1, '10-wizard-review-en');
    await byTestId(p1, 'wizard-create').click();
    await byTestId(p1, 'project-created').waitFor();
    await shot(p1, '11-project-created-en');
    await shot(p1, '12-project-schedule-history-en', 'history-card');

    // A second project at the same address shows the advisory overlap and similar-name warnings.
    await byTestId(p1, 'project-back').click();
    await wizardToReview(p1, 'Main Street Tower Annex');
    await byTestId(p1, 'address-candidate-0').click();
    await byTestId(p1, 'selected-address').waitFor();
    await byTestId(p1, 'wizard-next').click();
    await byTestId(p1, 'timezone-America/Chicago').click();
    await byTestId(p1, 'wizard-next').click();
    await byTestId(p1, 'overlap-warning').waitFor();
    await shot(p1, '13-wizard-overlap-warning-en', 'overlap-warning');

    // Leave the wizard without creating (Back to step 1, then Cancel), open the first project:
    // sensitive change → confirmation → version 2.
    for (let i = 0; i < 4; i += 1) await byTestId(p1, 'wizard-back').click();
    await p1.locator('[aria-label="Open project Main Street Tower"]:visible').first().click();
    await byTestId(p1, 'edit-settings').click();
    await byTestId(p1, 'radius-preset-500').click();
    await byTestId(p1, 'edit-reason').fill('Laydown yard added on the east lot');
    await byTestId(p1, 'save-config').click();
    await byTestId(p1, 'sensitive-confirmation').waitFor();
    await shot(p1, '14-sensitive-change-confirm-en', 'sensitive-confirmation');
    await byTestId(p1, 'confirm-sensitive').click();
    await byTestId(p1, 'version-2').waitFor();
    await shot(p1, '15-history-version-2-en', 'history-card');
    await shot(p1, '16-lifecycle-staff-en', 'lifecycle-card');

    await byTestId(p1, 'invite-staff').click();
    await byTestId(p1, 'invite-email').fill(inviteeEmail);
    await byTestId(p1, 'invite-role-SUPER').click();
    await byTestId(p1, 'invite-emergency').click();
    await byTestId(p1, 'invite-send').click();
    await byTestId(p1, 'invite-sent').waitFor();
    await shot(p1, '17-invite-created-en');

    // Invitee (Spanish): sign in with the invited e-mail, accept, view the project.
    const es = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'es-MX' });
    const p2 = await es.newPage();
    await staffSignIn(p2, 'es-US', inviteeEmail);
    await byTestId(p2, 'open-invitations').click();
    await p2.locator('[data-testid^="accept-"]').first().waitFor();
    await shot(p2, '18-invitations-es');
    await p2.locator('[data-testid^="accept-"]').first().click();
    await byTestId(p2, 'staff-home').waitFor();
    await openTab(p2, '/staff/projects', 'Proyectos');
    const card = p2.locator('[aria-label="Abrir el proyecto Main Street Tower"]:visible').first();
    await card.waitFor();
    await shot(p2, '19-projects-es');
    await card.click();
    await byTestId(p2, 'site-card').waitFor();
    await shot(p2, '20-project-detail-es');
    await shot(p2, '21-project-schedule-es', 'schedule-card');
    await byTestId(p2, 'edit-settings').click();
    await byTestId(p2, 'project-edit-screen').waitFor();
    await shot(p2, '22-edit-settings-es', 'dwell');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
