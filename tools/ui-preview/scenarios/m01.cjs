// Milestone 01 UI preview: first-launch language choice, sign-in shell, worker and staff tabs.
const { chromium } = require('playwright');

const [base, out] = process.argv.slice(2);
const viewport = { width: 390, height: 844 };

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`captured ${name}.png`);
}

const byTestId = (page, id) => page.locator(`[data-testid="${id}"]`).first();

async function main() {
  const browser = await chromium.launch();
  try {
    // Spanish phone: device suggestion highlights Español, user still chooses explicitly.
    const es = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'es-MX' });
    const p1 = await es.newPage();
    await p1.goto(base);
    await byTestId(p1, 'language-screen').waitFor();
    await shot(p1, '01-language-choice-es-device');
    await byTestId(p1, 'choose-es-US').click();
    await byTestId(p1, 'sign-in-screen').waitFor();
    await shot(p1, '02-sign-in-es');
    await byTestId(p1, 'preview-worker').click();
    await byTestId(p1, 'worker-home').waitFor();
    await shot(p1, '03-worker-home-es');
    await p1.getByText('Historial de horas').last().click();
    await byTestId(p1, 'worker-history').waitFor();
    await shot(p1, '04-worker-time-history-es');
    await p1.getByText('Perfil').last().click();
    await byTestId(p1, 'worker-profile').waitFor();
    await shot(p1, '05-worker-profile-language-es');

    // English phone: staff shell.
    const en = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' });
    const p2 = await en.newPage();
    await p2.goto(base);
    await byTestId(p2, 'language-screen').waitFor();
    await shot(p2, '06-language-choice-en-device');
    await byTestId(p2, 'choose-en-US').click();
    await byTestId(p2, 'sign-in-screen').waitFor();
    await shot(p2, '07-sign-in-en');
    await byTestId(p2, 'preview-staff').click();
    await byTestId(p2, 'staff-home').waitFor();
    await shot(p2, '08-staff-home-en');
    await p2.getByText('Workforce').last().click();
    await byTestId(p2, 'staff-workforce').waitFor();
    await shot(p2, '09-staff-workforce-en');
    await p2.getByText('More').last().click();
    await byTestId(p2, 'staff-more').waitFor();
    await shot(p2, '10-staff-more-language-en');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
