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
  await carryOutAudit({ page, stack, APP, orgName, see, shot, step, log });
  await workOrderOnlyShop({ page, stack, APP, orgName, see, shot, step, log });
  await importWithTemplate({ page, stack, APP, orgName, see, shot, step, log });
  await importFromApi({ page, stack, APP, orgName, see, shot, step, log });
  await competence({ browser, page, stack, APP, orgName, see, shot, step, log, colleague, watch });
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
    description: 'A sharp edge is being left inside the bore.', actions: [{ description: 'Deburr every part before it leaves the machine.' }], effectiveDate: today, acknowledgeBy: new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    scope: { parts: [{ partId: part.id }], machines: [], operations: [], departments: [], targets: [{ roleId: role.id }] },
  });
  await api('POST', `/quality-alerts/${alert.id}/issue`);
  const categories = (await api('GET', '/ncr-classifications?kind=category')).data;
  const product = categories.find((c) => c.code === 'PRODUCT');
  if (categories.length !== 11 || !product) throw new Error('the organisation did not start with the eleven default categories');
  const ncr = await api('POST', '/ncrs', { source: 'internal', title: 'Rod bore burr', partId: part.id, siteId: org.site, categoryId: product.id });
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
  // No import has run yet at this point of the journey (the owner holds a Controller seat, so may see imports); IN8 replaced the old "no connectors" sentence.
  await see(page.getByText(/No imports have run yet/));
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
  await page.goto(`${APP}/Non-Conformance/Register/${nc.id}`);
  await see(page.getByRole('heading', { name: 'Containment' }));

  step('source and category are separate: the NC says what kind of problem it is, and the owner corrects where it came from, with a reason');
  await see(page.getByRole('combobox', { name: /^Category/ }));
  if ((await page.getByRole('combobox', { name: /^Category/ }).inputValue()) !== 'Product') throw new Error('the category is not shown');
  await shot(page, '33a-nc-source-and-category');
  await page.getByRole('button', { name: 'Change source' }).click();
  const change = page.getByRole('dialog', { name: /^Change the source of / });
  await change.getByRole('combobox', { name: /^New source/ }).click();
  await page.getByRole('option', { name: /^Final inspection/ }).click();
  await change.getByLabel(/^Why is the source changing/).fill('Found when the finished rods were checked');
  await change.getByRole('button', { name: 'Change source' }).click();
  await see(page.getByText('Changed: Found when the finished rods were checked'));
  const { rows: [moved] } = await stack.admin.query(`select source, source_change_reason from public.nonconformances where id = $1`, [nc.id]);
  if (!moved || moved.source !== 'final_inspection') throw new Error(`the source was not changed: ${JSON.stringify(moved)}`);
  await page.goto(`${APP}/Non-Conformance/Register`);
  await see(page.getByRole('columnheader', { name: /Source/ }));
  await see(page.getByRole('cell', { name: 'Final inspection' }).first());
  await see(page.getByRole('cell', { name: 'Product' }).first());
  await page.goto(`${APP}/Non-Conformance/Register?source=customer`);
  await see(page.getByText('No records found.'));
  await page.getByRole('tab', { name: 'All' }).click();
  await see(page.getByRole('cell', { name: 'Final inspection' }).first());
  await shot(page, '33b-nc-register-source-category');
  await page.goto(`${APP}/Non-Conformance/Register/${nc.id}`);
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
  await page.goto(`${APP}/Audits/Templates`);
  await see(page.getByRole('button', { name: /New audit/ }));
  await shot(page, '56-audits-empty');
  await page.getByRole('button', { name: /New audit/ }).click();
  await see(page.getByRole('heading', { name: 'Define an audit' }));
  await page.getByLabel(/^Title/).fill('Weekly layered process audit, CNC cell');
  // Every drop-down is the custom combo box.
  const pick = async (scope, name, option) => {
    await scope.getByRole('combobox', { name }).click();
    await page.getByRole('option', { name: option }).click();
  };
  await pick(page, 'Type', /^Layered process audit/);
  await pick(page, 'How often', /^Every week/);
  await page.getByRole('textbox', { name: /^Procedure/ }).fill('1. Walk the cell with the cell leader.\n2. Answer each question from what you see.');
  // What it is relevant to: drop-downs that add to a list.
  await pick(page, 'Add a machine', /CNC-J1/);
  await pick(page, 'Add an operation', /^OP-10/);
  await see(page.getByRole('list', { name: 'Machines' }).getByText(/CNC-J1/));
  await see(page.getByRole('list', { name: 'Operations' }).getByText('OP-10'));
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
  await pick(q2, 'Answered with', /^Numeric/);
  await q2.getByLabel('Lower limit').fill('6');
  await q2.getByLabel('Upper limit').fill('9');
  await q2.getByLabel('Unit').fill('%');
  await page.getByRole('button', { name: /Add a question/ }).click();
  const q3 = page.getByRole('listitem', { name: 'Question 3' });
  await q3.getByLabel(/^Question/).fill('Condition of the floor');
  await pick(q3, 'Answered with', /^Multiple choice/);
  await q3.getByLabel('Option 1', { exact: true }).fill('Clean');
  await q3.getByLabel('Option 2', { exact: true }).fill('Oily');
  await q3.getByLabel('Option 2 is acceptable').uncheck();
  await page.getByRole('button', { name: /Add a question/ }).click();
  const q4 = page.getByRole('listitem', { name: 'Question 4' });
  await q4.getByLabel(/^Question/).fill('Housekeeping score');
  await pick(q4, 'Answered with', /^Rating/);
  await pick(q4, 'Lowest acceptable rating', /^3/);
  await q4.scrollIntoViewIfNeeded();
  await shot(page, '57-define-audit');
  await page.getByRole('button', { name: 'Define audit' }).click();
  await see(page.getByRole('heading', { name: /AUD-001 · Weekly layered process audit, CNC cell/ }));
  await see(page.getByRole('list', { name: 'Checklist' }).getByText('Critical'));
  await page.waitForTimeout(300);
  await shot(page, '58-audit-page');
  await page.goto(`${APP}/Audits/Templates`);
  await see(page.getByRole('region', { name: 'Audits' }).getByText('AUD-001'));
  const { rows: [d] } = await stack.admin.query(`select d.reference, d.frequency_kind, (select count(*)::int from public.audit_questions q where q.audit_definition_id = d.id) as questions,
      (select count(*)::int from public.audit_targets t where t.audit_definition_id = d.id) as targets from public.audit_definitions d join public.organisations o on o.id = d.organisation_id where o.name = $1`, [orgName]);
  log(`audit: ${JSON.stringify(d)}`);
  if (!d || d.frequency_kind !== 'weekly' || d.questions !== 4 || d.targets !== 2) throw new Error('the audit was not saved as defined');
}

/** The audit comes due on the schedule, someone carries it out, a critical question fails, and the failure becomes a draft non-conformance. */
async function carryOutAudit({ page, stack, APP, orgName, see, shot, step, log }) {
  step('the audit is carried out from the schedule, fails on a critical question, which needs a finding, and the finding is raised as a non-conformance');
  // Defined a month ago, so the schedule has had slots to miss.
  await stack.admin.query(
    `update public.audit_definitions d set created_at = now() - interval '30 days' from public.organisations o where o.id = d.organisation_id and o.name = $1`,
    [orgName]
  );
  await page.goto(`${APP}/Audits/Schedule`);
  await see(page.getByRole('table', { name: 'Scheduled audits' }));
  await shot(page, '59-audit-schedule');
  await page.getByRole('button', { name: /^Start AUD-001/ }).first().click();
  await see(page.getByRole('heading', { name: /^AR-\d\d-0001 · Weekly layered process audit/ }));
  // The tick is saved as it is made and shown a moment later, so wait for it rather than asking for it at once.
  await page.getByRole('checkbox', { name: 'OP-10' }).click();
  await page.getByRole('checkbox', { name: 'OP-10' }).and(page.locator(':checked')).waitFor();
  await page.getByRole('checkbox', { name: /CNC-J1/ }).click();
  await page.getByRole('checkbox', { name: /CNC-J1/ }).and(page.locator(':checked')).waitFor();
  const q1 = page.getByRole('listitem', { name: 'Question 1' });
  await q1.getByRole('radio', { name: 'Fail' }).click();
  await q1.getByLabel(/^What was found/).fill('Oil under the bench at the lathe');
  await q1.getByLabel(/^What was found/).press('Tab');
  const q2 = page.getByRole('listitem', { name: 'Question 2' });
  await q2.getByLabel('Answer to question 2').fill('7.5');
  await q2.getByLabel('Answer to question 2').press('Tab');
  // Each question shows the control its type asked for: a drop-down of the options, and the rating scale.
  const q3 = page.getByRole('listitem', { name: 'Question 3' });
  await q3.getByRole('combobox', { name: 'Answer to question 3' }).click();
  await page.getByRole('option', { name: 'Clean' }).click();
  const q4 = page.getByRole('listitem', { name: 'Question 4' });
  await q4.getByRole('radiogroup', { name: 'Answer to question 4' }).getByRole('radio', { name: '4', exact: true }).click();
  await shot(page, '60-audit-record-answered');
  // A failed critical question needs a finding before the audit can be completed.
  await see(page.getByText(/raise a finding for the failed critical question: 1/));
  await q1.getByRole('button', { name: 'Create finding' }).click();
  const create = page.getByRole('dialog', { name: 'Create a finding from question 1' });
  await see(create.getByLabel('Title'));
  await shot(page, '60a-audit-finding-dialog');
  await create.getByRole('button', { name: 'Raise finding' }).click();
  await see(page.getByRole('list', { name: 'Findings' }).getByRole('link', { name: /^AF-\d\d-0001$/ }));
  await page.getByRole('button', { name: 'Complete audit' }).click();
  await see(page.getByRole('status').filter({ hasText: /Failed with/ }));
  await see(page.getByText(/1 critical question failed/));
  await shot(page, '61-audit-record-failed');
  // The finding is raised as a non-conformance from its own page.
  await page.getByRole('list', { name: 'Findings' }).getByRole('link', { name: /^AF-\d\d-0001$/ }).click();
  await see(page.getByRole('heading', { name: /^AF-\d\d-0001 · / }));
  await shot(page, '61a-audit-finding');
  await page.getByRole('button', { name: 'Create non-conformance' }).click();
  const dialog = page.getByRole('dialog', { name: 'Raise a non-conformance' });
  await dialog.getByRole('button', { name: 'Raise non-conformance' }).click();
  await page.waitForURL(/\/Non-Conformance\/Register\//);
  await see(page.getByRole('heading', { name: 'Source audit' }));
  await page.waitForTimeout(400);
  await shot(page, '62-ncr-from-audit');

  await page.goto(`${APP}/Audits/Records`);
  await see(page.getByRole('region', { name: 'Audit records' }).getByRole('link', { name: /^AR-\d\d-0001$/ }));
  await see(page.getByRole('region', { name: 'Audit records' }).getByText('Fail'));
  await shot(page, '63-audit-records');
  await page.goto(`${APP}/Audits/Templates`);
  await see(page.getByRole('region', { name: 'Audits' }).getByText('Fail'));
  const { rows: [r] } = await stack.admin.query(
    `select r.status, r.result, r.critical_failed_count, r.occurrence_id is not null as scheduled,
            (select count(*)::int from public.audit_ncr_links l where l.audit_record_id = r.id and l.finding_id is not null) as links,
            (select count(*)::int from public.audit_findings f where f.audit_record_id = r.id and f.status = 'open') as findings,
            (select count(*)::int from public.audit_record_targets t where t.audit_record_id = r.id) as targets
       from public.audit_records r join public.organisations o on o.id = r.organisation_id where o.name = $1`,
    [orgName]
  );
  log(`audit record: ${JSON.stringify(r)}`);
  if (!r || r.status !== 'completed' || r.result !== 'fail' || r.critical_failed_count !== 1 || !r.scheduled || r.links !== 1 || r.findings !== 1 || r.targets !== 2) throw new Error('the audit was not carried out as expected');

  step('the quality team changes the audit and is asked why; the history shows the version, the reason and what changed, and the record keeps the version it was done against');
  await page.goto(`${APP}/Audits/Templates`);
  await page.getByRole('region', { name: 'Audits' }).getByRole('link', { name: 'AUD-001' }).click();
  await see(page.getByText('Version 1', { exact: true }).first());
  await page.getByRole('link', { name: 'Edit' }).click();
  await see(page.getByRole('heading', { name: 'Edit AUD-001' }));
  await page.getByLabel(/^Pass mark/).fill('90');
  await see(page.getByText('Saved as version 2, with this reason, in the version history'));
  await page.getByRole('button', { name: 'Save changes' }).click();
  await see(page.getByRole('alert', { name: 'Still needed' }).getByText('Say why the audit is changing'));
  await shot(page, '64-audit-change-needs-a-reason');
  await page.getByLabel(/^Why is this changing/).fill('Lowered the pass mark while the cell is being retrained');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await see(page.getByText('Version 2', { exact: true }).first());
  const versions = page.getByRole('table', { name: 'Versions' });
  await see(versions.getByText('Lowered the pass mark while the cell is being retrained'));
  await see(versions.getByText('First version'));
  await page.getByRole('button', { name: 'View version 2' }).click();
  const versionDialog = page.getByRole('dialog', { name: 'AUD-001 · version 2' });
  await see(versionDialog.getByRole('region', { name: 'Changes from version 1' }).getByText(/Pass mark: 100% → 90%/));
  await shot(page, '65-audit-version');
  await versionDialog.getByRole('button', { name: 'Close' }).click();
  await page.goto(`${APP}/Audits/Records`);
  await page.getByRole('region', { name: 'Audit records' }).getByRole('link', { name: /^AR-\d\d-0001$/ }).click();
  await see(page.getByTestId('record-version').getByText(/Done against version 1 of the audit \(the audit is now at version 2\)/));
  const { rows: [v] } = await stack.admin.query(
    `select (select count(*)::int from public.audit_versions x where x.audit_definition_id = d.id) as versions,
            (select audit_version from public.audit_records r where r.audit_definition_id = d.id order by r.created_at limit 1) as record_version,
            (select reason from public.audit_versions x where x.audit_definition_id = d.id and x.version = 2) as reason
       from public.audit_definitions d join public.organisations o on o.id = d.organisation_id where o.name = $1`, [orgName]);
  log(`audit versions: ${JSON.stringify(v)}`);
  if (!v || v.versions !== 2 || v.record_version !== 1 || v.reason !== 'Lowered the pass mark while the cell is being retrained') throw new Error('the audit change was not versioned as expected');

  step('the audits dashboard shows planned against done, findings, coverage and the change just made');
  await page.goto(`${APP}/Audits`);
  await see(page.getByRole('heading', { name: 'Audits dashboard' }));
  await see(page.getByRole('link', { name: /Audits completed/ }).getByText('1', { exact: true }));
  await see(page.getByRole('link', { name: /Open findings/ }));
  await see(page.getByRole('table', { name: 'Coverage' }));
  await see(page.getByRole('list', { name: 'Recent changes to audits' }).getByText(/Lowered the pass mark while the cell is being retrained/));
  await see(page.getByRole('table', { name: 'Questions that fail most often' }).getByText(/Is the cell clean and free of oil\?/));
  await page.waitForTimeout(500);
  await shot(page, '66-audits-dashboard');
}

/** A non-conformance names the lot it touches; the lot gate then asks for a disposition that covers that lot. */
async function affectedLots({ page, stack, APP, orgName, see, shot, step, log }) {
  step('the owner names the affected lot on a non-conformance, and the lot gate asks for it to be covered');
  const { rows: [nc] } = await stack.admin.query(
    `insert into public.nonconformances (organisation_id, reference, source, stage, title, severity, quantity_affected, description, site_id, part_id, category_id)
     select o.id, 'pending', 'internal', 'open', 'Lot 9001 bores oversize', 'minor', 5, 'Bores oversize on part of the lot', (select id from public.sites where organisation_id = o.id order by created_at limit 1),
            (select id from public.parts where organisation_id = o.id and part_number = 'JRN-100'),
            (select id from public.ncr_classifications where organisation_id = o.id and kind = 'category' and code = 'MATERIAL')
       from public.organisations o where o.name = $1 returning id, reference`, [orgName]);
  await page.goto(`${APP}/Non-Conformance/Register/${nc.id}`);
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
  // The lot is a combo box now (the disposition dialog's drop-downs became combos).
  await propose.getByRole('combobox', { name: 'Lot' }).click();
  await page.getByRole('option', { name: /^LOT-9001/ }).click();
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
  await page.goto(`${APP}/Non-Conformance/Register/${nc.id}`);
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

  step('the profile picture opens the account menu: who, Settings, Help, dark mode, Logout');
  await page.goto(`${APP}/`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  const accountMenu = page.getByRole('menu', { name: 'Account menu' });
  await see(accountMenu);
  for (const name of ['Settings', 'Help', 'Dark mode', 'Logout']) await see(accountMenu.getByRole(name === 'Dark mode' ? 'menuitemcheckbox' : 'menuitem', { name: new RegExp(name) }));
  await shot(page, '67-account-menu');
  await accountMenu.getByRole('menuitemcheckbox', { name: 'Dark mode' }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  await see(accountMenu); // choosing a switch leaves the menu open
  await page.waitForTimeout(500); // let the colours finish fading
  if ((await accountMenu.getByRole('menuitemcheckbox', { name: 'Dark mode' }).getAttribute('aria-checked')) !== 'true') throw new Error('the dark mode switch does not show on');
  await shot(page, '68-account-menu-dark');
  await page.reload();
  if (!(await page.evaluate(() => document.documentElement.classList.contains('dark')))) throw new Error('dark mode was not remembered after a reload');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menu', { name: 'Account menu' }).getByRole('menuitemcheckbox', { name: 'Dark mode' }).click(); // back to light
  await page.keyboard.press('Escape');
  if (await page.getByRole('menu', { name: 'Account menu' }).count()) throw new Error('Escape did not close the account menu');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menu', { name: 'Account menu' }).getByRole('menuitem', { name: 'Settings' }).click();
  await page.waitForURL(/\/Settings/);

  step('the "…" at the end of a register row opens the shared dropdown menu');
  await page.goto(`${APP}/Non-Conformance/Register`);
  const ncRow = page.getByRole('row', { name: /Rod bore burr/ });
  await ncRow.getByRole('button', { name: 'Actions' }).click();
  const rowMenu = page.getByRole('menu', { name: /Actions for NCM-/ });
  await see(rowMenu.getByRole('menuitem', { name: 'Open' }));
  await see(rowMenu.getByRole('menuitem', { name: 'Delete' }));
  await shot(page, '69-row-actions-menu');
  await page.keyboard.press('Escape');
  if (await page.getByRole('menu').count()) throw new Error('Escape did not close the row menu');
  await ncRow.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Open' }).click();
  await page.waitForURL(/\/Non-Conformance\/Register\/[0-9a-f-]{36}/);

  step('a person saves the filters they chose under a name, and finds it again');
  await page.goto(`${APP}/Non-Conformance/Register?stage=open`);
  await see(page.getByRole('tablist', { name: 'Saved filters' }));
  await page.getByRole('button', { name: 'Save filter' }).click();
  const saveDialog = page.getByRole('dialog', { name: 'Save filter' });
  await saveDialog.getByLabel(/Name/).fill('Open ones');
  await shot(page, '70-save-filter-dialog');
  await saveDialog.getByRole('button', { name: 'Save' }).click();
  await see(page.getByRole('tab', { name: 'Open ones' }));
  await page.waitForTimeout(500);
  await shot(page, '71-saved-filter');
  const { rows: stored } = await stack.admin.query(`select name, filters from public.saved_filters where name = 'Open ones'`);
  if (stored.length !== 1 || stored[0].filters.stage !== 'open') throw new Error('the saved filter was not stored with its filters');
  await page.goto(`${APP}/Non-Conformance/Register`);
  await see(page.getByRole('tab', { name: 'Open ones' }));
  await page.getByRole('tab', { name: 'Open ones' }).click();
  await page.waitForURL(/stage=open/);
  await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'Open ones' }).waitFor({ timeout: 5000 }); // highlighted once chosen
  await page.getByRole('tab', { name: 'All' }).click();
  await page.waitForFunction(() => !location.search.includes('stage='));

  step('where detected and the causal process are picked from the machines');
  await page.goto(`${APP}/Non-Conformance/Register`);
  await page.getByRole('row', { name: /Rod bore burr/ }).getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Open' }).click();
  await see(page.getByLabel('Title'));
  await page.getByRole('combobox', { name: 'Where detected' }).click();
  await page.getByRole('option', { name: /CNC-J1/ }).first().click();
  await page.getByRole('combobox', { name: 'Causal process' }).click();
  await page.getByRole('option', { name: /CNC-J1/ }).first().click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await see(page.getByText('Changes saved.'));
  const { rows: [placed] } = await stack.admin.query(
    `select md.code as detected, mc.code as causal from public.nonconformances n join public.machines md on md.id = n.detection_process_id join public.machines mc on mc.id = n.causal_process_id where n.title = 'Rod bore burr'`);
  if (!placed || placed.detected !== 'CNC-J1' || placed.causal !== 'CNC-J1') throw new Error(`the machines were not saved on the NC: ${JSON.stringify(placed)}`);
  await shot(page, '72-nc-machines');
}

/**
 * Import templates (docs/import-templates-plan.md, UI2d): switch on advanced imports, import machines from a CSV file in the wizard with a step on one field
 * and a formula on another (the examples come from the server preview), save the mapping as a template on the way, check what was written, then open the
 * template in the template manager.
 */
async function importWithTemplate({ page, stack, APP, orgName, see, shot, step, log }) {
  const org = (await stack.admin.query(`select id from public.organisations where name = $1`, [orgName])).rows[0];
  const site = (await stack.admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [org.id])).rows[0].code;

  step('owner switches on advanced imports');
  await page.goto(`${APP}/Settings/Integrations`);
  const advanced = page.getByRole('switch', { name: 'Advanced imports' });
  await see(advanced);
  await page.locator('label', { has: advanced }).click(); // the switch's checkbox is visually hidden inside its label
  await see(page.getByRole('link', { name: 'Manage templates' }));

  step('owner imports machines from a file with a step and a formula');
  await page.getByRole('link', { name: /Import a file/ }).click();
  await page.getByRole('button', { name: /^Machines/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await see(page.getByText('How to read the file'));
  const csv = ['Code,Name,Site,Area', `JT-LATHE-1,big lathe,${site},Bay 1`, `JT-MILL-2,small mill,${site},Bay 2`].join('\n');
  await page.locator('[data-testid="file-input"]').setInputFiles({ name: 'machines.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await see(page.getByRole('table', { name: 'First rows' }));
  await page.getByRole('button', { name: 'Next' }).click();

  const name = page.getByRole('listitem', { name: 'Name', exact: true });
  await see(name);
  await see(name.getByLabel('Example for Name').getByText('big lathe'));
  await name.getByRole('button', { name: 'Show settings for Name' }).click();
  const steps = name.getByRole('region', { name: 'Steps for Name' });
  await steps.getByRole('combobox', { name: 'Add a step' }).click();
  await page.getByRole('option', { name: /^Capitals/ }).click();
  await see(steps.getByLabel('After step 1').getByText('BIG LATHE'));

  const description = page.getByRole('listitem', { name: 'Description', exact: true });
  await description.getByRole('button', { name: 'Show settings for Description' }).click();
  await description.locator('label', { has: page.getByRole('switch', { name: 'Use a formula instead of a column' }) }).click();
  await description.getByLabel('Formula for Description').fill('CONCAT([Name], " in ", [Area])');
  await see(description.getByText('big lathe in Bay 1'));
  await shot(page, '60-import-mapping-steps-formula');

  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  const dialog = page.getByRole('dialog');
  await see(dialog.getByLabel('Template name'));
  await dialog.getByRole('button', { name: 'Save and import' }).click();
  await page.waitForURL(/\/runs\//);
  await see(page.getByText(/template Machines from machines\.csv version 1/));
  await shot(page, '61-import-run');
  const made = (await stack.admin.query(`select code, name, description from public.machines where organisation_id = $1 and code like 'JT-%' order by code`, [org.id])).rows;
  log(`imported machines: ${JSON.stringify(made)}`);
  if (made.length !== 2 || made[0].name !== 'BIG LATHE' || made[0].description !== 'big lathe in Bay 1') throw new Error(`the import did not write what the preview showed: ${JSON.stringify(made)}`);

  step('owner opens the template in the template manager');
  await page.goto(`${APP}/Settings/Integrations/Templates`);
  await page.getByRole('link', { name: 'Machines from machines.csv' }).click();
  await see(page.getByRole('button', { name: 'Version 1' }));
  await see(page.getByText('CONCAT([Name], " in ", [Area])'));
  await shot(page, '62-template-manager');
}

/**
 * Integrations exit check (IN9, connectors plan): a REST connection to the fake ERP set up in the browser — address, bearer token, records with paging —
 * tested, marked ready and activated; its fields mapped from what the API sends; imported; imported again without writing anything; a rejected record
 * fixed in the source and imported, another ignored with a reason; then the credential revoked, after which the connection can no longer be tested.
 */
async function importFromApi({ page, stack, APP, orgName, see, shot, step, log }) {
  const org = (await stack.admin.query(`select id from public.organisations where name = $1`, [orgName])).rows[0];
  const site = (await stack.admin.query(`select code from public.sites where organisation_id = $1 order by created_at limit 1`, [org.id])).rows[0].code;
  const { erp } = stack;
  erp.machines = [
    { id: '1', code: 'ERP-M1', name: 'Erp lathe', plant: site },
    { id: '2', code: 'ERP-M2', name: 'Erp mill', plant: site },
    { id: '3', code: 'ERP-M3', name: 'Erp grinder', plant: site },
    { id: '4', code: 'ERP-M4', name: '', plant: site }, // no name: rejected until the ERP is fixed
  ];
  const machines = async () => (await stack.admin.query(`select code, name from public.machines where organisation_id = $1 and code like 'ERP-%' order by code`, [org.id])).rows;
  const latestRun = async () => (await stack.admin.query(`select id, kind, status, jsonb_build_object('total', records_total, 'created', created, 'updated', updated, 'unchanged', unchanged, 'rejected', rejected, 'failed', failed) as counts from public.integration_sync_runs where organisation_id = $1 and entity_type = 'machine' and connection_id = (select id from public.integration_connections where organisation_id = $1 and name = 'Plant ERP') order by requested_at desc limit 1`, [org.id])).rows[0];

  step('owner connects the plant ERP through its REST API');
  await page.goto(`${APP}/Settings/Integrations`);
  await page.getByRole('button', { name: /Connect an API/ }).click();
  const form = page.getByRole('dialog', { name: 'Add a connection' });
  await form.getByLabel('Name', { exact: true }).fill('Plant ERP');
  await form.getByLabel('Address').fill('https://erp.journey-erp.com/api');
  await form.getByRole('combobox', { name: 'How we sign in' }).click();
  await page.getByRole('option', { name: /^Bearer token/ }).click();
  await form.getByLabel('Test path').fill('/health');
  await form.getByRole('button', { name: /Add a kind of record/ }).click();
  await form.getByRole('combobox', { name: 'Kind of record' }).click();
  await page.getByRole('option', { name: /^Machines/ }).click();
  await form.getByLabel('Path', { exact: true }).fill('/v1/machines');
  await form.getByLabel('Where the list is in the answer').fill('data');
  await form.getByRole('combobox', { name: 'Paging' }).click();
  await page.getByRole('option', { name: /^Page numbers/ }).click();
  await form.getByLabel('Records per page').fill('2');
  await form.getByLabel('Page parameter').fill('page');
  await form.getByLabel('Page size parameter').fill('per_page');
  await shot(page, '80-api-connection-form');
  await form.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/\/Settings\/Integrations\/[0-9a-f-]{36}$/);

  step('owner stores the token, tests the connection, marks it ready and activates it');
  await page.getByRole('button', { name: 'Store a credential' }).click();
  const cred = page.getByRole('dialog', { name: 'Store a credential' });
  await cred.getByLabel('Bearer token').fill(erp.token);
  await cred.getByRole('button', { name: 'Store' }).click();
  await see(page.getByText(/Bearer token stored/));
  await page.getByRole('button', { name: 'Test connection' }).click();
  await see(page.getByText(/The API answered 200 at \/api\/health/));
  await page.getByRole('button', { name: 'Mark ready' }).click();
  await page.getByRole('button', { name: 'Activate' }).click();
  await see(page.getByRole('button', { name: 'Pause' }));
  const secretShown = (await page.content()).includes(erp.token);
  if (secretShown) throw new Error('the stored token appears in the page');
  await shot(page, '81-api-connection-active');

  step('owner maps the fields from what the API sends and imports');
  await page.getByRole('link', { name: 'Map fields' }).click();
  await page.waitForURL(/\/map\?/);
  const code = page.getByRole('listitem', { name: 'Code', exact: true });
  await see(code);
  await see(page.getByText(/4 fields in the first 2 records/));
  const siteRow = page.getByRole('listitem', { name: 'Site', exact: true });
  await siteRow.getByRole('combobox', { name: 'API field for Site' }).click();
  await page.getByRole('option', { name: /^plant/ }).click();
  await see(code.getByLabel('Example for Code').getByText('ERP-M1'));
  await shot(page, '82-api-map-fields');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const save = page.getByRole('dialog');
  await see(save.getByLabel('Template name'));
  await save.getByRole('button', { name: 'Save and import' }).click();
  await page.waitForURL(/\/runs\//);
  await see(page.getByText(/Machines from Plant ERP/).first());
  await shot(page, '83-api-import-run');
  let made = await machines();
  let run = await latestRun();
  log(`first import: ${JSON.stringify(run.counts)} machines ${JSON.stringify(made)}`);
  if (made.length !== 3 || run.counts.created !== 3 || run.counts.rejected !== 1) throw new Error(`the first import did not write the three good records and reject the fourth: ${JSON.stringify({ made, counts: run.counts })}`);
  if (!erp.requests.some((r) => r.query.page === '2')) throw new Error('the import did not read the second page');

  step('the same import again writes nothing');
  const connId = (await stack.admin.query(`select id from public.integration_connections where organisation_id = $1 and name = 'Plant ERP'`, [org.id])).rows[0].id;
  await page.goto(`${APP}/Settings/Integrations/${connId}/map?entity=machine`);
  await see(page.getByText('Version 1, unchanged'));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.waitForURL(/\/runs\//);
  run = await latestRun();
  const mapped = Number((await stack.admin.query(`select count(*) from public.integration_external_records where connection_id = $1`, [connId])).rows[0].count);
  log(`second import: ${JSON.stringify(run.counts)}`);
  if ((await machines()).length !== 3 || mapped !== 3 || run.counts.created || run.counts.updated || run.counts.unchanged !== 3) throw new Error(`the second import was not a no-op: ${JSON.stringify(run.counts)}`);

  step('the rejected record is fixed in the ERP and imported; a new bad one is ignored with a reason');
  erp.machines[3].name = 'Erp drill';
  erp.machines.push({ id: '5', code: '', name: 'No code', plant: site });
  await page.goto(`${APP}/Settings/Integrations/${connId}/map?entity=machine`);
  await see(page.getByText('Version 1, unchanged'));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.waitForURL(/\/runs\//);
  run = await latestRun();
  made = await machines();
  log(`third import: ${JSON.stringify(run.counts)} machines ${JSON.stringify(made)}`);
  if (made.length !== 4 || !made.some((m) => m.code === 'ERP-M4' && m.name === 'Erp drill') || run.counts.rejected !== 1) throw new Error(`the fixed record was not imported: ${JSON.stringify({ made, counts: run.counts })}`);
  await page.goto(`${APP}/Settings/Integrations/${connId}`);
  const rows = page.getByRole('list', { name: 'Rows' });
  await see(rows.getByText(/No code|Code/).first());
  if (await rows.getByLabel('Choose 4').count()) throw new Error('the fixed record still needs a person');
  await rows.getByLabel('Choose 5').check();
  await page.getByRole('button', { name: 'Ignore 1' }).click();
  const why = page.getByRole('dialog', { name: 'Ignore these rows' });
  await why.getByLabel(/Why are they ignored/).fill('Test record in the ERP; it will never get a code');
  await why.getByRole('button', { name: 'Ignore' }).click();
  await see(page.getByText(/Nothing needs a person|No rows/).first());
  // Ignoring is optimistic: the screen changes at once, so wait for the save to land before reading the database.
  let ignored = [];
  for (let i = 0; i < 40 && ignored.length === 0; i += 1) {
    ignored = (await stack.admin.query(`select ignore_reason from public.integration_inbox where connection_id = $1 and status = 'ignored'`, [connId])).rows;
    if (ignored.length === 0) await page.waitForTimeout(250);
  }
  if (ignored.length !== 1) throw new Error(`the row was not ignored with its reason: ${JSON.stringify(ignored)}`);
  await shot(page, '84-api-rows-ignored');

  step('owner revokes the credential; the connection can no longer be tested');
  await page.getByRole('button', { name: 'Revoke' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke the credential' });
  await revoke.getByLabel('Reason').fill('Token rotated in the ERP');
  await revoke.getByRole('button', { name: 'Revoke' }).click();
  await see(page.getByText('No credential stored'));
  const before = erp.requests.length;
  await page.getByRole('button', { name: 'Test connection' }).click();
  await see(page.getByText(/Store the credential for this connection first/).first());
  if (erp.requests.length !== before) throw new Error('the test called the ERP without a credential');
  await shot(page, '85-api-credential-revoked');
}


/**
 * Competence exit check (CO5, competence plan): the organisation sets up a skill and a position that requires it; a person is given the position and assessed one level
 * short; they are put on a training session and completed; the dashboard and the matrix show the gap, the matrix exports as a CSV; and the person assessed, who holds no
 * competence permission, sees only their own record and was told they were assessed.
 */
async function competence({ browser, page, stack, APP, orgName, see, shot, step, log, colleague, watch }) {
  const org = (await stack.admin.query(`select id from public.organisations where name = $1`, [orgName])).rows[0];
  const ada = (await stack.admin.query(`select id from public."Employees" where organisation_id = $1 and first_name = 'Ada'`, [org.id])).rows[0];

  step('owner sets up a skill and a position that requires it');
  await page.goto(`${APP}/Settings/Data-Management?tab=competence`);
  await see(page.getByRole('button', { name: /Add skill/ }));
  await page.getByRole('button', { name: /Add skill/ }).click();
  const skill = page.getByRole('dialog', { name: 'Add a skill' });
  await skill.getByLabel('Code').fill('CMM');
  await skill.getByLabel('Name', { exact: true }).fill('CMM operation');
  await skill.getByLabel('Category').click();
  await page.getByRole('option', { name: /^Inspection/ }).click();
  await skill.getByLabel('Reassess every (months)').fill('12');
  await skill.getByRole('button', { name: 'Save' }).click();
  await see(page.getByRole('region', { name: 'Inspection' }).getByText(/CMM operation/));
  await page.getByRole('button', { name: /Add position/ }).click();
  const position = page.getByRole('dialog', { name: 'Add a position' });
  await position.getByLabel('Code').fill('INSP');
  await position.getByLabel('Name', { exact: true }).fill('CMM inspector');
  await position.getByRole('button', { name: 'Save' }).click();
  const positions = page.getByRole('list', { name: 'Positions' });
  await see(positions.getByText('CMM inspector'));
  await positions.getByRole('button', { name: /Required skills/ }).click();
  const required = page.getByRole('dialog', { name: /Skills required by CMM inspector/ });
  await required.getByRole('combobox', { name: 'Add a skill' }).click();
  await page.getByRole('option', { name: /CMM operation/ }).click();
  await required.getByRole('button', { name: 'Save' }).click();
  await see(positions.getByText('CMM operation 3'));
  await shot(page, '90-competence-setup');

  step('owner gives Ada the position and assesses her one level short');
  await page.goto(`${APP}/Competence/People/${ada.id}`);
  await see(page.getByRole('heading', { name: 'Ada Lovelace' }));
  await page.getByRole('button', { name: 'Give a position' }).click();
  const give = page.getByRole('dialog', { name: /Give Ada Lovelace a position/ });
  await give.getByRole('combobox', { name: 'Position' }).click();
  await page.getByRole('option', { name: /CMM inspector/ }).click();
  await give.getByRole('button', { name: 'Give position' }).click();
  await see(page.getByRole('button', { name: 'Assess CMM operation' }));
  await page.getByRole('button', { name: 'Assess CMM operation' }).click();
  const assess = page.getByRole('dialog', { name: /Assess Ada Lovelace/ });
  await assess.getByRole('combobox', { name: 'Level' }).click();
  await page.getByRole('option', { name: /2 · Supervised/ }).click();
  await assess.getByRole('button', { name: 'Record assessment' }).click();
  await see(page.getByText('Below required').first());
  await shot(page, '91-competence-person-gap');
  const made = (await stack.admin.query(`select level, expires_on is not null as has_expiry, status from public.competence_assessments where employee_id = $1`, [ada.id])).rows;
  log(`assessments: ${JSON.stringify(made)}`);
  if (made.length !== 1 || made[0].level !== 2 || !made[0].has_expiry || made[0].status !== 'current') throw new Error(`the assessment was not recorded as expected: ${JSON.stringify(made)}`);

  step('owner records a training session and completes Ada on her own day');
  await page.goto(`${APP}/Competence/Training`);
  await page.getByRole('button', { name: /New session/ }).click();
  const create = page.getByRole('dialog', { name: 'New training session' });
  await create.getByLabel('Title').fill('CMM basics');
  await create.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: 'Course', exact: true }).click();
  await create.getByRole('combobox', { name: 'Run by' }).click();
  await page.getByRole('option', { name: /External \(an outside provider\)/ }).click();
  await create.getByLabel('Provider or trainer').fill('Zeiss Academy');
  await create.getByRole('combobox', { name: 'Attendees' }).click();
  await page.getByRole('option', { name: /Ada Lovelace/ }).click();
  await create.getByRole('button', { name: 'Create session' }).click();
  await page.waitForURL(/\/Competence\/Training\/[0-9a-f-]{36}$/);
  await see(page.getByRole('heading', { name: 'CMM basics' }));
  await page.getByLabel('Select Ada Lovelace').check();
  await page.getByRole('button', { name: 'Record a result (1)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Record', exact: true }).click();
  await see(page.getByText(/Completed on/));
  await page.getByRole('button', { name: 'Close session' }).click();
  await see(page.getByRole('button', { name: 'Reopen' }));
  await shot(page, '92-competence-training-session');
  const attendee = (await stack.admin.query(`select status, completed_on is not null as dated from public.competence_session_attendees where employee_id = $1`, [ada.id])).rows;
  if (attendee.length !== 1 || attendee[0].status !== 'completed' || !attendee[0].dated) throw new Error(`the attendee was not completed with a date: ${JSON.stringify(attendee)}`);

  step('the dashboard and the matrix show the gap, and the matrix exports');
  await page.goto(`${APP}/Competence`);
  await see(page.getByRole('heading', { name: /Competence dashboard/ }));
  await see(page.getByRole('link', { name: /People with gaps/ }).getByText('1', { exact: true }));
  await see(page.getByRole('table', { name: 'People furthest short' }).getByRole('link', { name: 'Ada Lovelace' }));
  await shot(page, '93-competence-dashboard');
  await page.goto(`${APP}/Competence/Matrix`);
  const cell = page.getByLabel(/Ada Lovelace, CMM operation: Supervised \(2\) · needs 3/);
  await see(cell);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  const text = await require('node:fs/promises').readFile(await download.path(), 'utf8');
  log(`matrix export: ${download.suggestedFilename()} (${text.split('\n').length} lines)`);
  if (!/^skills-matrix-/.test(download.suggestedFilename()) || !text.includes('Below required') || !text.includes('Ada Lovelace')) throw new Error('the matrix export is missing what the screen shows');
  await shot(page, '94-competence-matrix');

  step('Ada, who holds no competence permission, sees only her own record and was told she was assessed');
  const notices = (await stack.admin.query(`select count(*)::int n from public.notifications n join auth.users u on u.id = n.recipient_user_id where n.entity_type = 'competence_assessments' and lower(u.email) = lower($1)`, [colleague.email])).rows[0];
  if (notices.n !== 1) throw new Error(`the person assessed was not told: ${JSON.stringify(notices)}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const own = await ctx.newPage();
  own.setDefaultTimeout(15000);
  watch(own, 'ada');
  await signIn(own, APP, colleague.email);
  await see(own.getByRole('heading', { level: 1, name: /good (morning|afternoon|evening), Colin/i }));
  await own.goto(`${APP}/Competence`);
  await see(own.getByRole('heading', { name: 'My competence' }));
  await see(own.getByText('Below required').first());
  if (await own.getByRole('button', { name: /Assess|Record an assessment|Give a position/ }).count()) throw new Error('someone without the right is offered an action on their own record');
  await shot(own, '95-competence-my-record');
  await ctx.close();
}
