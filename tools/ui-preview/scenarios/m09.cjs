// Milestone 09 UI preview against the LOCAL Supabase stack (web render, decision #52): the
// superintendent dashboard, a live update through the private Broadcast channel, the workforce
// roster, the site map (web schematic), the offline line and Spanish. The workforce is seeded in
// the local database relative to now (GPS, foreman, kiosk, printed badge, unknown, not seen).
const { chromium } = require('playwright');
const { Buffer } = require('node:buffer');
const { createHmac, randomUUID } = require('node:crypto');
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

/** Seeds companies, workers, sessions, presence, positions, a visitor and a pending enrollment. */
async function seedWorkforce(projectId) {
  const [{ config, tz, lat, lng }] = await query(
    `select p.config_version_id as config, p.iana_timezone as tz,
            extensions.st_y(g.center::extensions.geometry) as lat, extensions.st_x(g.center::extensions.geometry) as lng
       from public.projects p join public.project_geofences g on g.config_version_id = p.config_version_id
      where p.id = $1`,
    [projectId],
  );
  const southern = randomUUID();
  const bolt = randomUUID();
  await query(
    `insert into public.subcontractor_companies (id, canonical_name) values ($1, 'Southern Concrete'), ($2, 'Bolt Electric')`,
    [southern, bolt],
  );
  await query(
    `insert into public.project_subcontractors (project_id, subcontractor_id, status) values ($1, $2, 'APPROVED'), ($1, $3, 'APPROVED')`,
    [projectId, southern, bolt],
  );
  const enroll = async (name, company, trade, status = 'APPROVED') => {
    const [{ id }] = await query(
      `with w as (insert into public.worker_profiles (legal_name, managed_identity) values ($1, true) returning id),
            n as (select id from public.legal_notice_versions where document_id = 'WORKER_LOCATION_DISCLOSURE_EN_V1'),
            o as (insert into public.orientation_records (worker_profile_id, project_id, completed_at, notice_version_id)
                  select w.id, $2, now(), n.id from w, n returning worker_profile_id)
       insert into public.worker_enrollments (project_id, worker_id, subcontractor_id, trade, enrollment_status, employer_status,
                                              employer_confirmed_at, approval_at)
       select $2, o.worker_profile_id, $3, $4, $5::public.enrollment_status,
              case when $5 = 'APPROVED' then 'VERIFIED' else 'PENDING_CONFIRMATION' end::public.employer_status,
              case when $5 = 'APPROVED' then now() end, case when $5 = 'APPROVED' then now() end
         from o returning worker_id as id`,
      [name, projectId, company, trade, status],
    );
    return id;
  };
  const session = async (worker, company, source, startMinutes, seenMinutes, witnessed) => {
    const id = randomUUID();
    await query(
      `insert into public.attendance_sessions (id, project_id, worker_id, employer_snapshot_id, start_at, start_source, config_version_id,
                                               status, iana_timezone, last_seen_at, witnessed, start_confidence)
       values ($1, $2, $3, $4, now() - make_interval(mins => $5), ($6::text)::public.attendance_source, $7, 'OPEN', $8,
               now() - make_interval(mins => $9), $10,
               case when $6::text = 'KIOSK_PRINTED_BADGE' then 'LOW' else 'MEDIUM' end::public.evidence_confidence)`,
      [id, projectId, worker, company, startMinutes, source, config, tz, seenMinutes, witnessed],
    );
    await query(
      `insert into public.presence_states (project_id, worker_id, presence_state, last_seen_at, confidence, config_version_id, current_session_id)
       values ($1, $2, 'ONSITE_ESTIMATED', now() - make_interval(mins => $3), 'MEDIUM', $4, $5)`,
      [projectId, worker, seenMinutes, config, id],
    );
  };
  const position = async (worker, dLat, dLng, accuracy, minutes) =>
    query(
      `insert into public.latest_onsite_positions (project_id, worker_id, position, horizontal_accuracy_m, observed_at, expiry_at)
       values ($1, $2, extensions.st_setsrid(extensions.st_makepoint($3, $4), 4326)::extensions.geography, $5,
               now() - make_interval(mins => $6), now() - make_interval(mins => $6) + interval '20 minutes')`,
      [projectId, worker, lng + dLng, lat + dLat, accuracy, minutes],
    );
  const ana = await enroll('Ana Acosta', southern, 'Concrete');
  const ben = await enroll('Ben Avila', southern, 'Concrete');
  const carla = await enroll('Carla Diaz', bolt, 'Electrical');
  const diego = await enroll('Diego Ruiz', southern, 'Labor');
  const eva = await enroll('Eva Morales', bolt, 'Electrical');
  await enroll('Fernando Alvarez', bolt, 'Electrical');
  const gabe = await enroll('Gabe Lopez', southern, 'Concrete');
  await enroll('Paula Perez', southern, 'Concrete', 'PENDING');
  await session(ana, southern, 'GEOFENCE', 95, 2, false);
  await session(ben, southern, 'FOREMAN', 80, 80, true);
  await session(carla, bolt, 'KIOSK_PRINTED_BADGE', 70, 70, true);
  await session(diego, southern, 'GEOFENCE', 120, 30, false);
  await session(eva, bolt, 'GEOFENCE', 60, 12, false);
  await position(ana, 0.0004, -0.0003, 12, 2);
  await position(eva, -0.0005, 0.0004, 25, 12);
  const [{ host }] = await query(
    `select s.user_id as host from public.project_staff s where s.project_id = $1 limit 1`,
    [projectId],
  ).catch(() => [{ host: null }]);
  const visitor = randomUUID();
  await query(
    `insert into public.visitor_records (id, project_id, name, organization, host_user_id, purpose)
     values ($1, $2, 'Ivy Inspector', 'City of Houston', $3, 'Framing inspection')`,
    [visitor, projectId, host ?? null],
  );
  await query(
    `insert into public.visitor_visits (visitor_id, project_id, checked_in_at, idempotency_key, closeout_at)
     values ($1, $2, now() - interval '40 minutes', gen_random_uuid(), now() + interval '8 hours')`,
    [visitor, projectId],
  );
  return { gabe, southern, config, tz };
}

async function main() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' });
    const staff = await context.newPage();
    if (process.env.PREVIEW_DEBUG) {
      staff.on('websocket', (ws) => {
        console.log('WS open', ws.url().replace(/apikey=[^&]+/, 'apikey=…'));
        ws.on('framereceived', (f) => console.log('WS <-', String(f.payload).slice(0, 300)));
        ws.on('framesent', (f) => console.log('WS ->', String(f.payload).slice(0, 200)));
        ws.on('close', () => console.log('WS closed'));
      });
      staff.on('console', (m) => console.log('BROWSER', m.type(), m.text().slice(0, 300)));
    }
    const ownerEmail = `owner.m09.${Date.now()}@example.test`;
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
    const [{ id: projectId }] = await query(
      `select p.id from public.projects p join public.organizations o on o.id = p.organization_id
         join auth.users u on u.id = o.owner_user_id where u.email = $1`,
      [ownerEmail],
    );
    const seeded = await seedWorkforce(projectId);

    // Home: the only project is picked; the dashboard joins the private live channel.
    await byTestId(staff, 'project-back').click();
    await openTab(staff, '/staff/home');
    await byTestId(staff, 'dash-onsite').waitFor();
    await byTestId(staff, 'live-LIVE')
      .waitFor({ timeout: 20000 })
      .catch(async (error) => {
        const ids = await staff
          .locator('[data-testid^="live-"]')
          .evaluateAll((nodes) =>
            nodes.map((n) => `${n.dataset.testid}:${n.offsetParent !== null}`),
          );
        console.error('live status nodes:', ids.join(', '));
        await staff.screenshot({ path: `${out}/debug-live.png` });
        throw error;
      });
    await shot(staff, '01-dashboard-en');
    await shot(staff, '02-dashboard-companies-en', 'dash-companies');

    // A kiosk scan lands on the server: one minimal Broadcast, the count refreshes by itself.
    const before = await byTestId(staff, 'dash-onsite-count').innerText();
    const id = randomUUID();
    await query(
      `insert into public.attendance_sessions (id, project_id, worker_id, employer_snapshot_id, start_at, start_source, config_version_id,
                                               status, iana_timezone, last_seen_at, witnessed)
       values ($1, $2, $3, $4, now(), 'KIOSK_DYNAMIC_BADGE', $5, 'OPEN', $6, now(), true)`,
      [id, projectId, seeded.gabe, seeded.southern, seeded.config, seeded.tz],
    );
    await query(
      `insert into public.presence_states (project_id, worker_id, presence_state, last_seen_at, confidence, config_version_id, current_session_id)
       values ($1, $2, 'ONSITE_ESTIMATED', now(), 'HIGH', $3, $4)`,
      [projectId, seeded.gabe, seeded.config, id],
    );
    await staff.waitForFunction(
      ([selector, old]) => {
        const node = [...document.querySelectorAll(selector)].find((n) => n.offsetParent !== null);
        return node && node.textContent !== old;
      },
      ['[data-testid="dash-onsite-count"]', before],
      { timeout: 20000 },
    );
    await shot(staff, '03-dashboard-live-update-en', 'dash-onsite');

    await openTab(staff, '/staff/workforce');
    await staff.locator('[data-testid^="member-"]:visible').first().waitFor();
    await shot(staff, '04-workforce-roster-en');

    await openTab(staff, '/staff/map');
    await byTestId(staff, 'map-markers').waitFor();
    await shot(staff, '05-map-en');
    await shot(staff, '06-map-markers-en', 'map-markers');

    // Offline: the last numbers stay, with the time they were loaded.
    await openTab(staff, '/staff/home');
    await byTestId(staff, 'dash-onsite').waitFor();
    await openTab(staff, '/staff/more');
    await byTestId(staff, 'language-switch-es-US').waitFor();
    await openTab(staff, '/staff/home');
    await context.setOffline(true);
    await byTestId(staff, 'live-refresh').click();
    await byTestId(staff, 'live-offline').waitFor({ timeout: 20000 });
    await shot(staff, '07-dashboard-offline-en');
    await context.setOffline(false);

    // Spanish.
    await openTab(staff, '/staff/more');
    await byTestId(staff, 'language-switch-es-US').click();
    await openTab(staff, '/staff/home');
    await staff.getByText('Estimado en la obra', { exact: false }).first().waitFor();
    await shot(staff, '08-dashboard-es');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
