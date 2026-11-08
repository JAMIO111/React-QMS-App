/** Waits until something is on screen (plain Playwright: no test runner here). */
const see = (locator) => locator.first().waitFor({ state: 'visible' });
const RUN = Date.now().toString(36);
const PASSWORD = 'Journey-Pass-2026';

/** Confirms the address the way the emailed link would. */
const verify = (stack, email) => stack.admin.query(`update auth.users set email_confirmed_at = now() where lower(email) = lower($1)`, [email]);

async function signUp(page, APP, { first, surname, email }) {
  await page.goto(`${APP}/signup`);
  await page.getByLabel('First name').fill(first);
  await page.getByLabel('Surname').fill(surname);
  await page.getByLabel('Work email').fill(email);
  await page.locator('input[autocomplete="new-password"]').fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function signIn(page, APP, email) {
  await page.goto(`${APP}/login`);
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}

module.exports = async function journey({ browser, stack, APP, watch, shot, step, log }) {
  const owner = { first: 'Olivia', surname: 'Owner', email: `olivia.${RUN}@journey.test` };
  const colleague = { first: 'Colin', surname: 'Colleague', email: `colin.${RUN}@journey.test` };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  watch(page, 'owner');

  step('owner signs up');
  await signUp(page, APP, owner);
  await see(page.getByText(/check your email/i).first());
  await shot(page, '01-check-email');

  step('owner verifies and signs in');
  await verify(stack, owner.email);
  await signIn(page, APP, owner.email);
  await see(page.getByRole('heading', { name: /start your organisation/i }));
  await shot(page, '02-start-organisation');

  step('owner starts an organisation');
  await page.getByLabel('Organisation name').fill(`Journey Works ${RUN}`);
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/setup/);
  await see(page.getByRole('heading', { name: /plan and seats/i }));
  await shot(page, '03-plan-step-locked');

  step('owner buys seats at the (fake) Checkout');
  await page.getByRole('button', { name: 'Add Contributor seat' }).click();
  await page.getByRole('button', { name: 'Add Contributor seat' }).click();
  await shot(page, '04-seats-chosen');
  await page.getByRole('button', { name: 'Continue to secure checkout' }).click();
  await see(page.getByText(/free trial until/i));
  await shot(page, '05-subscribed');
  const sub = (await stack.admin.query(`select s.status, (select sum(quantity) from public.organisation_subscription_items i where i.organisation_id = s.organisation_id) seats from public.organisation_subscriptions s join public.organisations o on o.id = s.organisation_id where o.name = $1`, [`Journey Works ${RUN}`])).rows[0];
  log(`subscription: ${JSON.stringify(sub)}`);
  if (sub.status !== 'trialing' || Number(sub.seats) !== 3) throw new Error('the subscription was not recorded as expected');

  step('owner walks the wizard: details, sites, security');
  await page.getByRole('button', { name: 'Continue' }).click();
  await see(page.getByRole('heading', { name: /organisation details/i }));
  await page.getByLabel('Legal name').fill(`Journey Works ${RUN} Limited`);
  await page.getByRole('button', { name: 'Save details' }).click();
  await shot(page, '06-details');
  await page.getByRole('button', { name: /done, continue/i }).click();
  await see(page.getByRole('heading', { name: /sites and departments/i }));
  await page.getByRole('button', { name: /MAIN/ }).first().click();
  const addDepartment = page.getByRole('form', { name: 'Add department' });
  await addDepartment.getByLabel('Code').fill('QA');
  await addDepartment.getByLabel('Name').fill('Quality');
  await addDepartment.getByRole('button', { name: 'Add department' }).click();
  await see(page.getByText('Quality', { exact: false }).filter({ hasText: 'QA' }));
  await shot(page, '07-sites');
  // The site pop-up: code, name, time zone, currency (the organisation's by default) and departments.
  await page.getByRole('button', { name: 'Edit' }).first().click();
  const siteDialog = page.getByRole('dialog', { name: /Edit site/ });
  await see(siteDialog.getByRole('combobox', { name: 'Currency' }));
  await see(siteDialog.getByRole('region', { name: 'Departments' }).getByText('Quality'));
  await shot(page, '07b-site-dialog');
  await siteDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await see(page.getByRole('heading', { name: /^security$/i }));
  await shot(page, '08-security');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await see(page.getByRole('heading', { name: /your team/i }));
  await shot(page, '09-team');

  step('owner invites a colleague');
  await page.getByLabel('Email addresses').fill(colleague.email);
  await page.getByRole('button', { name: 'Add to the list' }).click();
  const everyone = page.getByRole('group', { name: 'Set for everyone' });
  const roleOptions = await everyone.getByLabel('Role for everyone').locator('option').allTextContents();
  const inspector = roleOptions.find((t) => /inspector/i.test(t));
  await everyone.getByLabel('Role for everyone').selectOption(inspector ? { label: inspector } : { index: 1 });
  await everyone.getByLabel('Department for everyone').selectOption({ index: 1 });
  await everyone.getByLabel('Package for everyone').selectOption({ label: 'Contributor' });
  await shot(page, '10-invite-ready');
  await page.getByRole('button', { name: /send 1 invitation/i }).click();
  await see(page.getByRole('list', { name: 'Results' }));
  await shot(page, '11-invited');
  const invited = (await stack.admin.query(`select m.status, m.invite_expires_at is not null as has_expiry from public.organisation_users m join public.organisations o on o.id = m.organisation_id where o.name = $1 and lower(m.invited_email) = lower($2)`, [`Journey Works ${RUN}`, colleague.email])).rows[0];
  log(`invitation: ${JSON.stringify(invited)}`);
  if (invited?.status !== 'invited') throw new Error('the invitation was not created');

  step('owner reviews and finishes');
  await page.getByRole('button', { name: /done, continue/i }).click();
  await see(page.getByRole('heading', { name: /review and finish/i }));
  await shot(page, '12-review');
  await page.getByRole('button', { name: /finish set-up|finish/i }).last().click();
  await page.waitForURL(/\/Dashboard/);
  await see(page.getByRole('heading', { level: 1 }));
  await shot(page, '13-dashboard');
  const seats = async () => Object.fromEntries((await stack.admin.query(
    `select p.slug, count(*)::int as held from public.user_subscription_assignments a join public.subscription_plans p on p.id = a.subscription_plan_id
      join public.organisations o on o.id = a.organisation_id where o.name = $1 and a.status = 'active' group by p.slug`, [`Journey Works ${RUN}`])).rows.map((r) => [r.slug, r.held]));
  const afterInvite = await seats();
  log(`seats held after the invite: ${JSON.stringify(afterInvite)}`);
  if (afterInvite.controller !== 1 || afterInvite.contributor !== 1) throw new Error('the owner should hold the Controller seat and the invitation should reserve a Contributor seat');

  step('the colleague signs up, signs in and accepts the invitation');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await ctx2.newPage();
  page2.setDefaultTimeout(15000);
  watch(page2, 'colleague');
  await signUp(page2, APP, colleague);
  await see(page2.getByText(/check your email/i));
  await verify(stack, colleague.email);
  await signIn(page2, APP, colleague.email);
  await see(page2.getByRole('heading', { name: /start your organisation/i }));
  await see(page2.getByText(`Journey Works ${RUN}`));
  await shot(page2, '14-colleague-sees-invitation');
  await page2.getByRole('button', { name: 'Accept' }).first().click();
  await see(page2.getByRole('heading', { level: 1, name: /good (morning|afternoon|evening), Colin/i }));
  await shot(page2, '15-colleague-accepted');
  const joined = (await stack.admin.query(`select m.status from public.organisation_users m join public.organisations o on o.id = m.organisation_id where o.name = $1 and lower(m.invited_email) = lower($2)`, [`Journey Works ${RUN}`, colleague.email])).rows[0];
  log(`colleague membership: ${JSON.stringify(joined)}`);
  if (joined?.status !== 'active') throw new Error('the colleague did not join');
  await ctx2.close();
  const finalSeats = await seats();
  log(`seats held at the end: ${JSON.stringify(finalSeats)}`);
  if (finalSeats.controller !== 1 || finalSeats.contributor !== 1) throw new Error('joining must keep the reserved seat');

  step('the owner sees the go-live card and the payment warning when things slip');
  const orgName = `Journey Works ${RUN}`;
  await stack.admin.query(`update public.departments set active = false where organisation_id = (select id from public.organisations where name = $1)`, [orgName]);
  await stack.admin.query(`update public.organisation_subscriptions set status = 'past_due', past_due_since = now() - interval '2 days' where organisation_id = (select id from public.organisations where name = $1)`, [orgName]);
  await page.goto(`${APP}/Dashboard`);
  await see(page.getByRole('region', { name: 'Go-live checklist' }));
  await see(page.getByRole('alert').filter({ hasText: /last payment failed/i }));
  await shot(page, '16-go-live-card-and-payment-warning');
  await page.goto(`${APP}/Settings/Subscription`);
  await see(page.getByText(/payment is overdue/i));
  if ((await page.getByRole('alert').filter({ hasText: /last payment failed/i }).count()) !== 0) throw new Error('the banner should not repeat on the billing page');
  await shot(page, '17-billing-page');

  step('the owner keeps the employees register (Master Data)');
  await stack.admin.query(`update public.organisation_subscriptions set status = 'active', past_due_since = null where organisation_id = (select id from public.organisations where name = $1)`, [orgName]);
  await page.goto(`${APP}/Employees`);
  await see(page.getByRole('button', { name: 'New employee' }));
  await page.getByRole('button', { name: 'New employee' }).click();
  const employeeDialog = page.getByRole('dialog', { name: 'New employee' });
  await employeeDialog.getByLabel('First name').fill('Ada');
  await employeeDialog.getByLabel('Surname').fill('Lovelace');
  await employeeDialog.getByLabel('Job title').fill('Inspector');
  await employeeDialog.getByLabel('Employee number').fill('E-001');
  await shot(page, '18-new-employee');
  await employeeDialog.getByRole('button', { name: 'Add employee' }).click();
  const register = page.getByRole('region', { name: 'Employees' });
  await see(register.getByText('Ada Lovelace'));
  await shot(page, '19-employees-register');
  const saved = (await stack.admin.query(`select e.first_name, e.employee_number, e.active from public."Employees" e join public.organisations o on o.id = e.organisation_id where o.name = $1`, [orgName])).rows;
  log(`employees: ${JSON.stringify(saved)}`);
  if (saved.length !== 1 || saved[0].employee_number !== 'E-001') throw new Error('the employee was not saved');

  // The owner holds the Controller seat, so they can link Ada to the colleague's sign-in.
  await register.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit Ada Lovelace' });
  const accountLink = editDialog.getByRole('region', { name: 'Sign-in account' });
  await see(accountLink.getByRole('combobox', { name: 'Member' }));
  await accountLink.getByRole('combobox', { name: 'Member' }).click();
  await page.getByRole('option', { name: /Colin Colleague/ }).click();
  await shot(page, '20-link-sign-in');
  await accountLink.getByRole('button', { name: 'Link sign-in' }).click();
  await see(accountLink.getByText(/Linked to Colin Colleague/));
  const linkedRow = (await stack.admin.query(`select count(*)::int n from public."Employees" e join auth.users u on u.id = e.auth_id where lower(u.email) = lower($1)`, [colleague.email])).rows[0];
  if (linkedRow.n !== 1) throw new Error('the sign-in was not linked');

  await jobHub({ page, stack, APP, orgName, see, shot, step, log, owner });
  await masterDataOverview({ page, stack, APP, orgName, see, shot, step, log });
  await correctRevision({ page, stack, APP, orgName, see, shot, step, log });
  await containAndDispose({ page, stack, APP, orgName, see, shot, step, log });
  await productionTraceability({ page, stack, APP, orgName, see, shot, step, log });
  await affectedLots({ page, stack, APP, orgName, see, shot, step, log });
  await defineAudit({ page, stack, APP, orgName, see, shot, step, log });
  await workOrderOnlyShop({ page, stack, APP, orgName, see, shot, step, log });
};

/** Calls the real API as a person (a token signed like the stand-in Supabase does), for set-up the browser steps do not cover. */
const apiAs = (stack, userId, email, organisationId) => async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${stack.ports.api}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${await stack.sign({ id: userId, email })}`, 'X-Organisation-Id': organisationId, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

/** The operator job hub (docs/operator-hub-plan.md): start a job from the dashboard, fill in the work order, open each pane, record a check, complete. */
async function jobHub({ page, stack, APP, orgName, see, shot, step, log, owner }) {
  step('set-up for the operator hub: a part with an effective control plan, an alert, a non-conformance');
  const { rows: [org] } = await stack.admin.query(`select o.id, (select id from public.sites where organisation_id = o.id limit 1) as site from public.organisations o where o.name = $1`, [orgName]);
  const { rows: [user] } = await stack.admin.query(`select id from auth.users where lower(email) = lower($1)`, [owner.email]);
  const { rows: [role] } = await stack.admin.query(`select id from public.roles where organisation_id = $1 and key = 'owner'`, [org.id]);
  const api = apiAs(stack, user.id, owner.email, org.id);
  const family = await api('POST', '/part-families', { code: 'JRN', name: 'Journey rods' });
  const part = await api('POST', '/parts', { partNumber: 'JRN-100', name: 'Journey rod', partFamilyId: family.id, initialRevision: { revision: 'A' } });
  await api('POST', '/machines', { code: 'CNC-J1', name: 'Journey lathe', siteId: org.site });
  const plan = await api('POST', '/control-plans', { planCode: 'CP-JRN', title: 'Journey rods', partFamilyId: family.id });
  const planRev = plan.revisions[0].id;
  const rev = await api('POST', `/control-plan-revisions/${planRev}/operations`, { operationCode: 'OP-10', name: 'Turning' });
  await api('POST', `/control-plan-revisions/${planRev}/characteristics`, {
    operationId: rev.operations[0].id, characteristicKey: 'VISUAL', name: 'No chatter marks', dataType: 'attribute', sampling: [{ triggerType: 'first_off', sampleSize: 1 }],
  });
  await api('PATCH', `/control-plan-revisions/${planRev}`, { changeReason: 'First release' });
  await api('POST', `/part-revisions/${part.revisions[0].id}/release`);
  await api('POST', `/control-plan-revisions/${planRev}/transitions`, { action: 'submit' });
  await api('POST', `/control-plan-revisions/${planRev}/transitions`, { action: 'approve' });
  const today = new Date().toISOString().slice(0, 10);
  const alert = await api('POST', '/quality-alerts', { title: 'Burr on the bore', category: 'product', severity: 'high' });
  await api('PATCH', `/quality-alerts/${alert.id}`, {
    description: 'A sharp edge is being left inside the bore.', requiredAction: 'Deburr every part before it leaves the machine.', effectiveDate: today, acknowledgeBy: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    scope: { parts: [{ partId: part.id }], machines: [], operations: [], departments: [], targets: [{ roleId: role.id }] },
  });
  await api('POST', `/quality-alerts/${alert.id}/issue`);
  const ncr = await api('POST', '/ncrs', { source: 'internal', title: 'Rod bore burr', partId: part.id, siteId: org.site });
  await api('PATCH', `/ncrs/${ncr.id}`, { severity: 'minor', quantityAffected: 2, description: 'Burr found at final check' });
  await api('POST', `/ncrs/${ncr.id}/transitions`, { to: 'open' });

  step('the operator starts a job from the dashboard with a part, then its control plan, operation and machine');
  await page.goto(`${APP}/Dashboard`);
  await see(page.getByRole('region', { name: 'Jobs' }));
  await shot(page, '21-dashboard-start-job-card');
  await page.getByRole('button', { name: 'Start new job' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a new job' });
  await dialog.getByRole('combobox', { name: /Part number/ }).click();
  await dialog.getByRole('combobox', { name: /Part number/ }).fill('JRN-100');
  await page.getByRole('option', { name: /JRN-100/ }).click();
  await see(dialog.getByText(/Control plan CP-JRN rev A is in force/));
  await dialog.getByRole('combobox', { name: /Machine/ }).click();
  await page.getByRole('option', { name: /CNC-J1/ }).click();
  await see(dialog.getByRole('button', { name: 'Start job' }));
  await shot(page, '22-start-job-popup');
  await dialog.getByRole('button', { name: 'Start job' }).click();
  await page.waitForURL(/\/Jobs\//);
  await see(page.getByRole('heading', { level: 1, name: 'JRN-100 · CNC-J1' }));
  await shot(page, '23-job-hub');
  const started = (await stack.admin.query(`select status, operation_code, machine_id is not null as has_machine, work_order from public.inspection_records where organisation_id = $1`, [org.id])).rows;
  log(`jobs: ${JSON.stringify(started)}`);
  if (started.length !== 1 || started[0].status !== 'in_progress' || started[0].operation_code !== 'OP-10' || !started[0].has_machine) throw new Error('the job was not started as expected');

  step('the operator types the work order, and opens each pane');
  await page.getByLabel('Work order').fill('WO-J-1001');
  await page.getByLabel('Work order').press('Tab');
  await page.waitForFunction(() => true);
  for (let i = 0; i < 20; i++) {
    const wo = (await stack.admin.query(`select work_order from public.inspection_records where organisation_id = $1`, [org.id])).rows[0].work_order;
    if (wo === 'WO-J-1001') break;
    if (i === 19) throw new Error('the work order was not saved');
    await new Promise((r) => setTimeout(r, 250));
  }
  await page.getByRole('button', { name: /^Alerts, 1/ }).click();
  const pane = page.locator('#job-pane');
  await see(pane.getByText('Burr on the bore'));
  await see(pane.getByText('Deburr every part before it leaves the machine.'));
  await page.waitForTimeout(500); // the pane slides in over 300 ms
  await shot(page, '24-alerts-pane');
  await page.getByRole('button', { name: /^NCs, 1/ }).click();
  await see(pane.getByText(/Rod bore burr/));
  await page.waitForTimeout(500); // the pane slides in over 300 ms
  await shot(page, '25-ncs-pane');
  await page.getByRole('button', { name: /^Revisions, / }).click();
  await see(pane.getByText('New').first());
  await page.waitForTimeout(500); // the pane slides in over 300 ms
  await shot(page, '26-revisions-pane');
  await pane.getByRole('button', { name: 'Close pane' }).click();

  step('the operator records the check and completes the job');
  await page.getByRole('radiogroup', { name: /No chatter marks reading/ }).getByRole('radio', { name: 'Pass' }).click();
  await page.getByRole('button', { name: 'Save sample' }).click();
  await see(page.getByRole('table', { name: 'Readings' }));
  await page.getByRole('button', { name: 'Complete inspection' }).click();
  await see(page.getByText('Completed', { exact: true })); // the status pill ("Pass" also labels the radio button)
  await shot(page, '27-job-completed');
  const done = (await stack.admin.query(`select status, result from public.inspection_records where organisation_id = $1`, [org.id])).rows[0];
  log(`job ended: ${JSON.stringify(done)}`);
  if (done.status !== 'completed' || done.result !== 'pass') throw new Error('the job did not complete with a pass');
}

/** The master data overview, over what the journey has created by now (a part and its family, a machine, an employee, a released revision). */
async function masterDataOverview({ page, stack, APP, orgName, see, shot, step, log }) {
  step('the owner opens the master data overview');
  await page.goto(`${APP}/Master-Data`);
  await see(page.getByRole('heading', { level: 1, name: 'Master data overview' }));
  const totals = page.getByLabel('Totals');
  await see(totals.getByRole('link', { name: /Parts/ }));
  await see(page.getByRole('list', { name: 'Data quality checks' }));
  await see(page.getByText(/No connectors, imports or sync runs are set up yet/));
  await see(page.getByRole('list', { name: 'Latest events' }));
  await page.waitForTimeout(600); // charts animate in
  await shot(page, '28-master-data-overview');
  await page.getByRole('heading', { level: 1, name: 'Master data overview' }).evaluate((h) => { let el = h.parentElement; while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement; el?.scrollTo(0, el.scrollHeight); });
  await page.waitForTimeout(400);
  await shot(page, '29-master-data-overview-lower');
  const { rows: [counts] } = await stack.admin.query(`select (select count(*) from public.parts p join public.organisations o on o.id = p.organisation_id where o.name = $1)::int as parts`, [orgName]);
  const shown = await totals.getByRole('link', { name: /Parts/ }).innerText();
  log(`parts in the database: ${counts.parts}; tile says: ${shown.replace(/\s+/g, ' ')}`);
  if (!new RegExp(`\\b${counts.parts}\\b`).test(shown)) throw new Error('the Parts tile does not match the database');
}

/** A drawing revision that does not match the system: correct it (same letter, next version), approve it, and see what ran on the earlier version. */
async function correctRevision({ page, stack, APP, orgName, see, shot, step, log }) {
  step('the owner corrects the released revision of JRN-100 without changing its letter');
  const { rows: [part] } = await stack.admin.query(`select p.id from public.parts p join public.organisations o on o.id = p.organisation_id where o.name = $1 and p.part_number = 'JRN-100'`, [orgName]);
  await page.goto(`${APP}/Parts/${part.id}`);
  await see(page.getByRole('heading', { level: 1, name: /JRN-100/ }));
  await shot(page, '30-part-before-correction');
  await page.getByRole('button', { name: 'Correct revision A' }).click();
  const dialog = page.getByRole('dialog', { name: 'Correct revision A' });
  await dialog.getByLabel(/What is wrong in the system/).fill('The drawing allows 100.2 at most; our record said 100.1');
  await shot(page, '31-correct-dialog');
  await dialog.getByRole('button', { name: 'Start correction' }).click();
  const table = page.getByRole('table', { name: 'Revisions' });
  await see(table.getByText('A v2'));
  await see(table.getByText(/Correction of A v1: The drawing allows 100.2/));
  await page.getByRole('button', { name: 'Approve and release' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve and release A v2' });
  await see(approve.getByText(/1 inspection used it/));
  await shot(page, '32-approve-correction');
  await approve.getByRole('button', { name: 'Approve and release' }).click();
  await see(page.getByText('Current revision:').filter({ hasText: 'A v2' }));
  await see(page.getByRole('region', { name: 'Revision A was corrected' }));
  await see(page.getByRole('table', { name: 'Inspections that used the earlier version' }));
  await page.waitForTimeout(400);
  await shot(page, '33-after-correction');
  const { rows } = await stack.admin.query(`select version, status, corrects_id is not null as is_correction from public.part_revisions where part_id = $1 order by version`, [part.id]);
  log(`revisions: ${JSON.stringify(rows)}`);
  if (rows.length !== 2 || rows[0].status !== 'corrected' || rows[1].status !== 'released' || !rows[1].is_correction) throw new Error('the correction was not released as expected');
  const { rows: [used] } = await stack.admin.query(`select count(*)::int as n from public.inspection_records i join public.part_revisions r on r.id = i.part_revision_id where r.part_id = $1 and r.version = 1`, [part.id]);
  if (used.n !== 1) throw new Error('the earlier inspection should still be on version 1');
}

/** An NC through containment and disposition: the gates say what is missing, the records are made, an approver approves, and the NC skips ahead. */
async function containAndDispose({ page, stack, APP, orgName, see, shot, step, log }) {
  step('the owner contains and dispositions the non-conformance raised earlier');
  const { rows: [nc] } = await stack.admin.query(`select n.id, n.reference from public.nonconformances n join public.organisations o on o.id = n.organisation_id where o.name = $1 and n.title = 'Rod bore burr'`, [orgName]);
  await page.goto(`${APP}/Non-Conformance/Internal/${nc.id}`);
  await see(page.getByRole('heading', { name: 'Containment' }));
  const needed = page.getByLabel('Needed for the next stage');
  await see(needed.getByText(/record a containment action, or say why none is needed/));
  await page.getByRole('button', { name: 'Move to Contained' }).click();
  await see(page.getByRole('alert').filter({ hasText: /Before this can move to contained/ }));
  await shot(page, '34-gate-refuses-contained');

  await page.getByRole('button', { name: 'Add containment action' }).click();
  const add = page.getByRole('dialog', { name: 'Add a containment action' });
  await add.getByLabel(/What is being done/).fill('Quarantine lot 77 and tell the supervisor');
  await add.getByRole('button', { name: 'Add action' }).click();
  await see(page.getByRole('list', { name: 'Containment actions' }).getByText('Quarantine lot 77 and tell the supervisor'));
  await page.getByRole('button', { name: 'Done…' }).click();
  const done = page.getByRole('dialog', { name: 'Mark the action done' });
  await done.getByLabel(/What was done and what was found/).fill('2 pieces quarantined, none shipped');
  await done.getByRole('button', { name: 'Mark done' }).click();
  await see(page.getByText(/2 pieces quarantined, none shipped/));
  await see(page.getByRole('status').filter({ hasText: 'Containment is resolved.' }));
  await shot(page, '35-containment-done');

  await page.getByRole('button', { name: 'Propose a disposition' }).click();
  const propose = page.getByRole('dialog', { name: 'Propose a disposition' });
  await propose.getByLabel(/Instructions/).fill('Scrap both and record the lot numbers');
  await propose.getByRole('button', { name: 'Propose' }).click();
  await see(page.getByRole('list', { name: 'Dispositions' }).getByText('Scrap both and record the lot numbers'));
  await page.getByRole('button', { name: 'Approve…' }).click();
  await page.getByRole('dialog', { name: 'Approve this disposition' }).getByRole('button', { name: 'Approve' }).click();
  await see(page.getByRole('status').filter({ hasText: 'Approved dispositions cover everything affected.' }));
  await page.waitForTimeout(400);
  await shot(page, '36-disposition-approved');

  // Everything is settled, so the NC can skip ahead past Contained and Investigating.
  await page.getByLabel('Move to a later stage').selectOption('dispositioned');
  await page.locator('section[aria-label="Stage"] li[aria-current="step"]').filter({ hasText: 'Dispositioned' }).waitFor({ state: 'visible' });
  const { rows: [after] } = await stack.admin.query(`select n.stage, (select count(*)::int from public.ncr_containment_actions where nonconformance_id = n.id and status = 'done') as done,
      (select count(*)::int from public.ncr_dispositions where nonconformance_id = n.id and status = 'approved') as approved from public.nonconformances n where n.id = $1`, [nc.id]);
  log(`NC ${nc.reference}: ${JSON.stringify(after)}`);
  if (after.stage !== 'dispositioned' || after.done !== 1 || after.approved !== 1) throw new Error('the NC was not dispositioned with its containment and disposition recorded');
}

/** The quality team defines an audit: checklist, what it is relevant to, frequency and pass mark; it appears in the Audits register. */
async function defineAudit({ page, stack, APP, orgName, see, shot, step, log }) {
  step('the quality team defines a weekly layered process audit and finds it in the Audits register');
  await page.goto(`${APP}/Documentation/Audits`);
  await see(page.getByRole('button', { name: /New audit/ }));
  await shot(page, '56-audits-empty');
  await page.getByRole('button', { name: /New audit/ }).click();
  await see(page.getByRole('heading', { name: 'Define an audit' }));
  await page.getByLabel(/^Title/).fill('Weekly layered process audit, CNC cell');
  await page.getByLabel(/^Type/).selectOption('layered_process');
  await page.getByLabel(/^How often/).selectOption('weekly');
  await page.getByRole('textbox', { name: /^Procedure/ }).fill('1. Walk the cell with the cell leader.\n2. Answer each question from what you see.');
  await page.getByLabel('Operation code').fill('OP-10');
  await page.getByLabel('Operation code').press('Enter');
  // The calendar closes when the page scrolls, so bring the field into view first.
  await page.getByRole('button', { name: /^First due/ }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /^First due/ }).click();
  await page.getByRole('dialog', { name: 'Choose first due' }).getByRole('button', { name: /\d{4}$/ }).first().click();
  await page.getByRole('button', { name: /Add a question/ }).click();
  const q1 = page.getByRole('listitem', { name: 'Question 1' });
  await q1.getByLabel(/^Question/).fill('Is the cell clean and free of oil?');
  await q1.getByLabel(/Critical/).check();
  await page.getByRole('button', { name: /Add a question/ }).click();
  const q2 = page.getByRole('listitem', { name: 'Question 2' });
  await q2.getByLabel(/^Question/).fill('Coolant concentration');
  await q2.getByLabel(/Answered with/).selectOption('number');
  await q2.getByLabel('Lower limit').fill('6');
  await q2.getByLabel('Upper limit').fill('9');
  await q2.getByLabel('Unit').fill('%');
  await shot(page, '57-define-audit');
  await page.getByRole('button', { name: 'Define audit' }).click();
  await see(page.getByRole('heading', { name: /AUD-001 · Weekly layered process audit, CNC cell/ }));
  await see(page.getByRole('list', { name: 'Checklist' }).getByText('Critical'));
  await page.waitForTimeout(300);
  await shot(page, '58-audit-page');
  await page.goto(`${APP}/Documentation/Audits`);
  await see(page.getByRole('region', { name: 'Audits' }).getByText('AUD-001'));
  const { rows: [d] } = await stack.admin.query(`select d.reference, d.frequency_kind, (select count(*)::int from public.audit_questions q where q.audit_definition_id = d.id) as questions,
      (select count(*)::int from public.audit_targets t where t.audit_definition_id = d.id) as targets from public.audit_definitions d join public.organisations o on o.id = d.organisation_id where o.name = $1`, [orgName]);
  log(`audit: ${JSON.stringify(d)}`);
  if (!d || d.frequency_kind !== 'weekly' || d.questions !== 2 || d.targets !== 1) throw new Error('the audit was not saved as defined');
}

/** A non-conformance names the lot it touches; the lot gate then asks for a disposition that covers that lot. */
async function affectedLots({ page, stack, APP, orgName, see, shot, step, log }) {
  step('the owner names the affected lot on a non-conformance, and the lot gate asks for it to be covered');
  const { rows: [nc] } = await stack.admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, title, severity, quantity_affected, description, site_id, part_id)
     select o.id, 'pending', 'internal', 'open', 'Lot 9001 bores oversize', 'minor', 5, 'Bores oversize on part of the lot', (select id from public.sites where organisation_id = o.id order by created_at limit 1),
            (select id from public.parts where organisation_id = o.id and part_number = 'JRN-100')
       from public.organisations o where o.name = $1 returning id, reference`, [orgName]);
  await page.goto(`${APP}/Non-Conformance/Internal/${nc.id}`);
  await see(page.getByRole('heading', { name: 'Affected lots' }).first());
  await see(page.getByText(/No lots named\. The quantity affected stands against the production order/));
  await page.getByRole('button', { name: 'Add a lot' }).click();
  const add = page.getByRole('dialog', { name: 'Add an affected lot' });
  await add.getByRole('combobox', { name: /^Lot/ }).click();
  await page.getByRole('option', { name: /LOT-9001/ }).click();
  await add.getByText('SN-0001').click();
  await add.getByText('SN-0002').click();
  await shot(page, '51-add-affected-lot');
  await add.getByRole('button', { name: 'Add lot' }).click();
  const list = page.getByRole('list', { name: 'Affected lots' });
  await see(list.getByText('LOT-9001 · 5'));
  await see(list.getByText('Serial numbers: SN-0001, SN-0002'));

  await page.getByLabel('Move to a later stage').selectOption('dispositioned');
  await see(page.getByRole('alert').filter({ hasText: /lot LOT-9001: approved dispositions cover 0 of the 5 affected/ }));

  await page.getByRole('button', { name: 'Propose a disposition' }).click();
  const propose = page.getByRole('dialog', { name: 'Propose a disposition' });
  await propose.getByLabel('Lot').selectOption({ label: 'LOT-9001 (5 affected)' });
  await propose.getByLabel(/Instructions/).fill('Scrap the five oversize pieces from lot 9001');
  await propose.getByRole('button', { name: 'Propose' }).click();
  await see(page.getByRole('list', { name: 'Dispositions' }).getByText('Lot LOT-9001'));
  await page.getByRole('button', { name: 'Approve…' }).click();
  await page.getByRole('dialog', { name: 'Approve this disposition' }).getByRole('button', { name: 'Approve' }).click();
  await see(page.getByRole('list', { name: 'Affected lots' }).getByText('5 of 5 approved'));
  await page.waitForTimeout(400);
  await shot(page, '52-lot-covered');
  const { rows: [after] } = await stack.admin.query(
    `select (select count(*)::int from public.ncr_affected_lots where nonconformance_id = $1 and removed_at is null) as lots,
            (select count(*)::int from public.ncr_dispositions where nonconformance_id = $1 and status = 'approved' and lot_id is not null) as approved_for_lot`, [nc.id]);
  log(`NC ${nc.reference}: ${JSON.stringify(after)}`);
  if (after.lots !== 1 || after.approved_for_lot !== 1) throw new Error('the lot and its disposition were not recorded');

  step('the owner traces the order: its lot, serial numbers and the non-conformance that names the lot');
  await page.goto(`${APP}/Production/Traceability`);
  await page.getByLabel('Find an order, lot or serial number').fill('WO-9001');
  await page.getByRole('list', { name: 'Matches' }).getByRole('button', { name: /WO-9001/ }).click();
  await see(page.getByRole('heading', { name: 'WO-9001' }));
  await see(page.getByRole('table', { name: 'Lots' }).getByText('LOT-9001'));
  await see(page.getByRole('list', { name: 'Serial numbers' }).getByText('SN-0005'));
  const ncs = page.getByRole('table', { name: 'Non-conformances' });
  await see(ncs.getByText('Names an affected lot'));
  await see(ncs.getByText('1 approved (5)'));
  await page.waitForTimeout(400);
  await shot(page, '53-trace-order-with-lots');

  step('the owner follows the lot link and sees the same non-conformance from the lot, with its order above it');
  await page.getByRole('table', { name: 'Lots' }).getByRole('link', { name: 'LOT-9001' }).click();
  await see(page.getByRole('heading', { name: 'LOT-9001' }));
  await see(page.getByText('Traceability report · Lot'));
  await see(page.getByRole('link', { name: 'WO-9001' }));
  const lotNcs = page.getByRole('table', { name: 'Non-conformances' });
  await see(lotNcs.getByText('Names an affected lot'));
  await see(lotNcs.getByText('1 approved (5)'));
  await page.waitForTimeout(400);
  await shot(page, '55-trace-lot');
}

/** A production order with an operation, a lot made for it and a numbered range of serial numbers, then a hold and a refused completion. */
async function productionTraceability({ page, stack, APP, orgName, see, shot, step, log }) {
  step('the owner makes a production order, a lot for it and five serial numbers');
  const pickPart = async (scope) => {
    await scope.getByRole('combobox', { name: /^Part/ }).click();
    await scope.getByRole('combobox', { name: /^Part/ }).fill('JRN-100');
    await page.getByRole('option', { name: /JRN-100/ }).click();
  };
  await page.goto(`${APP}/Production/Orders`);
  await see(page.getByRole('button', { name: 'New order' }));
  await shot(page, '37-production-orders-empty');
  await page.getByRole('button', { name: 'New order' }).click();
  const orderDialog = page.getByRole('dialog', { name: 'New production order' });
  await orderDialog.getByLabel('Order number').fill('WO-9001');
  await orderDialog.getByLabel('Quantity planned').fill('250');
  await pickPart(orderDialog);
  await shot(page, '38-new-order');
  await orderDialog.getByRole('button', { name: 'Create order' }).click();
  await see(page.getByRole('heading', { level: 1, name: 'Order WO-9001' }));
  const form = page.getByRole('form', { name: 'Add an operation' });
  await form.getByLabel('Operation code').fill('OP-10');
  await form.getByLabel('Description').fill('Turning');
  await form.getByRole('button', { name: 'Add operation' }).click();
  await see(page.getByRole('table', { name: 'Operations' }).getByText('OP-10'));
  await page.getByRole('group', { name: 'Change Order status' }).getByRole('button', { name: 'Release' }).click();
  await see(page.getByRole('group', { name: 'Change Order status' }).getByRole('button', { name: 'Start' }));
  await page.getByRole('group', { name: 'Change Order status' }).getByRole('button', { name: 'Start' }).click();
  await see(page.getByRole('group', { name: 'Change Order status' }).getByRole('button', { name: 'Complete' }));
  await shot(page, '39-order-page');

  step('the database refuses to complete the order while an operation is open');
  await page.getByRole('group', { name: 'Change Order status' }).getByRole('button', { name: 'Complete' }).click();
  await see(page.getByText(/Complete or skip every operation first; still open: OP-10/));
  await shot(page, '40-completion-refused');
  await page.getByRole('table', { name: 'Operations' }).getByRole('button', { name: 'Start' }).click();
  await page.getByRole('table', { name: 'Operations' }).getByRole('button', { name: 'Complete' }).click();
  await see(page.getByRole('table', { name: 'Operations' }).getByText('Completed'));

  await page.goto(`${APP}/Production/Lots`);
  await page.getByRole('button', { name: 'New lot' }).click();
  const lotDialog = page.getByRole('dialog', { name: 'New lot' });
  await lotDialog.getByLabel('Lot number').fill('LOT-9001');
  await pickPart(lotDialog);
  await lotDialog.getByRole('combobox', { name: 'Production order' }).click();
  await page.getByRole('option', { name: /WO-9001/ }).click();
  await lotDialog.getByLabel('Quantity').fill('250');
  await lotDialog.getByRole('button', { name: 'Create lot' }).click();
  const lots = page.getByRole('region', { name: 'Lots' });
  await see(lots.getByText('LOT-9001'));
  await see(lots.getByText('WO-9001'));

  await page.goto(`${APP}/Production/Serials`);
  await page.getByRole('button', { name: 'New serial numbers' }).click();
  const serialDialog = page.getByRole('dialog', { name: 'New serial numbers' });
  await pickPart(serialDialog);
  await serialDialog.getByRole('combobox', { name: 'Lot' }).click();
  await page.getByRole('option', { name: /LOT-9001/ }).click();
  await serialDialog.getByRole('tab', { name: 'A range' }).click();
  await serialDialog.getByLabel('Prefix').fill('SN-');
  await serialDialog.getByLabel('To').fill('5');
  await see(serialDialog.getByText(/5 serial numbers: SN-0001 … SN-0005/));
  await shot(page, '41-new-serial-range');
  await serialDialog.getByRole('button', { name: 'Add 5 serial numbers' }).click();
  const serials = page.getByRole('region', { name: 'Serial numbers' });
  await see(serials.getByText('SN-0005'));
  await page.waitForTimeout(400);
  await shot(page, '42-serial-numbers');

  step('the lot is put on hold with a reason, and an order is never lost to a typo in a number');
  await page.goto(`${APP}/Production/Lots`);
  await page.getByRole('region', { name: 'Lots' }).getByText('LOT-9001').dblclick();
  const lotView = page.getByRole('dialog', { name: 'Lot LOT-9001' });
  await lotView.getByRole('button', { name: 'Put on hold' }).click();
  const ask = page.getByRole('dialog', { name: 'Put on hold' });
  await ask.getByLabel('Why is the lot on hold?').fill('Supplier certificate missing');
  await ask.getByRole('button', { name: 'Put on hold' }).click();
  await see(lotView.getByText('Supplier certificate missing'));
  await shot(page, '43-lot-on-hold');

  const { rows: [r] } = await stack.admin.query(
    `select (select po.status from public.production_orders po join public.organisations o on o.id = po.organisation_id where o.name = $1 and po.order_number = 'WO-9001') as order_status,
            (select l.status::text || '/' || (l.production_order_id is not null)::text from public.lots l join public.organisations o on o.id = l.organisation_id where o.name = $1 and l.lot_number = 'LOT-9001') as lot,
            (select count(*)::int from public.serial_numbers n join public.lots l on l.id = n.lot_id join public.organisations o on o.id = n.organisation_id
               where o.name = $1 and l.lot_number = 'LOT-9001' and n.production_order_id = l.production_order_id) as serials_with_order`,
    [orgName],
  );
  log(`production: ${JSON.stringify(r)}`);
  if (r.order_status !== 'in_progress' || r.lot !== 'on_hold/true' || r.serials_with_order !== 5) throw new Error('the production records are not as expected');
}

/**
 * A shop that works to work orders only (WO-154789 x 24, no lots, no serial numbers): switch lots and serial numbers off, make the order from the job's own picker, run the job and an NC on it,
 * then link the work order typed on an old, finished inspection to a real order with the backfill.
 */
async function workOrderOnlyShop({ page, stack, APP, orgName, see, shot, step, log }) {
  step('a shop with no lots or serial numbers switches them off');
  await page.goto(`${APP}/Settings/Organisation`);
  const production = page.getByRole('region', { name: 'Production settings' });
  await production.getByRole('switch', { name: 'Track lots and serial numbers', checked: true }).click();
  await production.getByRole('switch', { name: 'Track lots and serial numbers', checked: false }).waitFor();
  await shot(page, '44-production-settings');
  const { rows: [flag] } = await stack.admin.query(`select s.use_lots_and_serials from public.organisation_settings s join public.organisations o on o.id = s.organisation_id where o.name = $1`, [orgName]);
  if (flag.use_lots_and_serials !== false) throw new Error('the setting was not saved');

  step('the Production menu now offers only orders');
  await page.goto(`${APP}/Dashboard`);
  await page.getByRole('button', { name: /^Production/ }).click().catch(() => page.getByTitle('Production').first().click());
  await see(page.getByRole('link', { name: 'Orders', exact: true }));
  if ((await page.getByRole('link', { name: 'Lots', exact: true }).count()) !== 0 || (await page.getByRole('link', { name: 'Serial numbers', exact: true }).count()) !== 0) throw new Error('lots and serial numbers are still in the menu');
  await shot(page, '45-menu-orders-only');

  step('the operator starts a job and makes the work order from the job itself');
  await page.goto(`${APP}/Dashboard`);
  await page.getByRole('button', { name: 'Start new job' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start a new job' });
  await dialog.getByRole('combobox', { name: /Part number/ }).click();
  await dialog.getByRole('combobox', { name: /Part number/ }).fill('JRN-100');
  await page.getByRole('option', { name: /JRN-100/ }).click();
  await see(dialog.getByText(/Control plan CP-JRN rev A is in force/));
  await dialog.getByRole('combobox', { name: /Machine/ }).click();
  await page.getByRole('option', { name: /CNC-J1/ }).click();
  await dialog.getByRole('button', { name: 'Not listed? Make a new order' }).click();
  const make = page.getByRole('dialog', { name: 'Make a production order' });
  await make.getByLabel('Order number').fill('WO-154789');
  await make.getByLabel('Quantity ordered').fill('24');
  await shot(page, '46-make-order');
  await make.getByRole('button', { name: 'Make order' }).click();
  await see(dialog.getByRole('combobox', { name: /Production order/ }));
  await dialog.getByRole('button', { name: 'Start job' }).click();
  await page.waitForURL(/\/Jobs\//);
  const records = page.getByLabel('Production records');
  await see(records.getByRole('combobox', { name: 'Production order' }));
  if ((await records.getByRole('combobox', { name: 'Lot' }).count()) !== 0) throw new Error('the lot picker is offered to a shop that does not use lots');
  await see(page.getByLabel('Work order').and(page.locator(':disabled')));
  const workOrder = await page.getByLabel('Work order').inputValue();
  if (workOrder !== 'WO-154789') throw new Error(`the work order text is "${workOrder}", not the order's number`);
  await shot(page, '47-job-on-the-order');
  const { rows: [job] } = await stack.admin.query(
    `select i.work_order, po.order_number, po.quantity_planned::int as qty, i.lot_id is null as no_lot from public.inspection_records i join public.production_orders po on po.id = i.production_order_id
      join public.organisations o on o.id = i.organisation_id where o.name = $1 and i.status = 'in_progress'`, [orgName]);
  log(`job on the order: ${JSON.stringify(job)}`);
  if (!job || job.order_number !== 'WO-154789' || job.qty !== 24 || !job.no_lot) throw new Error('the job is not linked to the order as expected');

  step('the non-conformance raised earlier is linked to the same order');
  const { rows: [nc] } = await stack.admin.query(`select n.id from public.nonconformances n join public.organisations o on o.id = n.organisation_id where o.name = $1 and n.title = 'Rod bore burr'`, [orgName]);
  await page.goto(`${APP}/Non-Conformance/Internal/${nc.id}`);
  await see(page.getByRole('heading', { name: 'Containment' }));
  const orderPicker = page.getByRole('combobox', { name: 'Production order' });
  await orderPicker.click();
  await page.getByRole('option', { name: /WO-154789/ }).click();
  if ((await page.getByLabel('Work order').inputValue()) !== 'WO-154789') throw new Error('the NC work order text was not filled in');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await see(page.getByText('Changes saved.'));
  await shot(page, '48-nc-on-the-order');
  const { rows: [linked] } = await stack.admin.query(`select n.work_order, po.order_number from public.nonconformances n join public.production_orders po on po.id = n.production_order_id where n.id = $1`, [nc.id]);
  if (!linked || linked.order_number !== 'WO-154789' || linked.work_order !== 'WO-154789') throw new Error('the NC was not linked to the order');

  step('the order alone tells the whole story, with no lots or serial numbers');
  await page.goto(`${APP}/Production/Orders`);
  await page.getByRole('row', { name: /WO-154789/ }).getByRole('link', { name: 'Trace' }).click();
  await see(page.getByRole('heading', { name: 'WO-154789' }));
  await see(page.getByRole('table', { name: 'Inspections' }));
  await see(page.getByRole('table', { name: 'Non-conformances' }).getByText('Rod bore burr'));
  if (await page.getByRole('table', { name: 'Lots' }).count()) throw new Error('lots are shown to a shop that does not use them');
  await page.waitForTimeout(400);
  await shot(page, '54-trace-order-only');

  step('the work order typed on an old, finished inspection is linked to a real order');
  await page.goto(`${APP}/Settings/Organisation`);
  const settings = page.getByRole('region', { name: 'Production settings' });
  await settings.getByRole('button', { name: 'Preview' }).click();
  const report = settings.getByLabel('Backfill report');
  await see(report.getByText(/would be made/));
  await see(report.getByText('This is what would happen (nothing has changed):'));
  await shot(page, '49-backfill-preview');
  const before = (await stack.admin.query(`select count(*)::int n from public.production_orders po join public.organisations o on o.id = po.organisation_id where o.name = $1`, [orgName])).rows[0].n;
  await settings.getByRole('button', { name: 'Link them' }).click();
  await page.getByRole('button', { name: 'Link them' }).last().click(); // the confirmation
  await see(settings.getByLabel('Backfill report').getByText('Done:'));
  await shot(page, '50-backfill-done');
  const { rows: [after] } = await stack.admin.query(
    `select (select count(*)::int from public.production_orders po join public.organisations o on o.id = po.organisation_id where o.name = $1) as orders,
            (select i.work_order || '/' || (i.production_order_id is not null)::text from public.inspection_records i join public.organisations o on o.id = i.organisation_id
              where o.name = $1 and i.work_order = 'WO-J-1001') as job`, [orgName]);
  log(`orders before ${before}, after ${after.orders}; the old job: ${after.job}`);
  if (after.orders <= before || after.job !== 'WO-J-1001/true') throw new Error('the old inspection was not linked to a production order with its text left alone');
}
