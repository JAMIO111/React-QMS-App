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
};
