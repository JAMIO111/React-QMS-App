import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import RHFComboBox from "../ui/RHFComboBox";
import OrganisationLogo from "../Settings/OrganisationLogo";
import RequireMfaSetting from "../Settings/RequireMfaSetting";
import SitesManager from "../Settings/SitesManager";
import ThemeColourPicker from "../Settings/ThemeColourPicker";
import TwoFactorCard from "../Settings/TwoFactorCard";
import { describeApiError } from "../../lib/api-client";
import { countryOptions } from "../../lib/onboarding";
import { useOrganisationDetails, useSites, useUpdateOrganisation } from "../../hooks/useQmsApi";
import { useSubscriptionOverview } from "../../hooks/useSubscription";
import { FormError, buttonClass } from "../master-data/shared";

/** Step 1: the organisation's name, and where the first site is. */
export const OrganisationStep = () => {
  const { data: org } = useOrganisationDetails();
  const sites = useSites();
  const update = useUpdateOrganisation();
  const [name, setName] = useState(org?.name ?? "");
  useEffect(() => setName(org?.name ?? ""), [org?.name]);
  const first = sites.data?.data?.[0] ?? sites.data?.items?.[0];
  const dirty = org && name.trim() !== org.name;
  return (
    <div className="flex flex-col gap-4">
      <MenuCard as="form" aria-label="Organisation name" title="Name" subtitle="Shown in the app and on your reports" bodyClassName="flex flex-col gap-3"
        onSubmit={(e) => { e.preventDefault(); if (dirty) update.mutate({ body: { name: name.trim() } }); }}>
        <Field label="Organisation name" required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <FormError error={update.error} />
        <div className="flex justify-end">
          <button type="submit" className={buttonClass.neutral} disabled={!dirty || update.isPending}>{update.isPending ? "Saving…" : "Save name"}</button>
        </div>
      </MenuCard>
      {first && (
        <p className="text-sm text-secondary-text">
          First site: <span className="text-primary-text">{first.name}</span> ({first.code}), time zone <span className="text-primary-text">{first.timezone}</span>. You can add sites and change this in the Sites step.
        </p>
      )}
    </div>
  );
};

/** Step 2: the plan. In this build it explains the rule and shows the current subscription; buying arrives with the payment provider. */
export const PlanStep = ({ state }) => {
  const overview = useSubscriptionOverview();
  const sub = overview.data?.subscription;
  const open = state.accessState === "open";
  return (
    <div className="flex flex-col gap-4">
      <MenuCard title="Subscription" subtitle={open ? "Your subscription is active" : state.billingRequired ? "A subscription is needed before you can use Fortress QMS" : "Choose your plan when you are ready"}>
        <div className="flex flex-col gap-2 text-sm text-primary-text">
          {open ? (
            <p>
              Your organisation has a valid subscription{sub?.status ? ` (${sub.status.replace("_", " ")})` : ""}, and the owner holds a Controller seat.
            </p>
          ) : (
            <>
              <p>Fortress QMS is priced per seat: Observer (read only), Contributor (record and complete work) and Controller (full functionality). You need at least one <strong>Controller</strong> seat, and the owner takes it.</p>
              <p className="text-secondary-text">{state.billingRequired ? "Everything except billing and set-up stays locked until the subscription is active." : "Nothing is locked yet, but you can set up your plan now."}</p>
            </>
          )}
          <p>
            <Link to="/Settings/Subscription" className="text-link-color underline">Open Subscription &amp; billing</Link>
          </p>
        </div>
      </MenuCard>
    </div>
  );
};

/** Step 3: legal name, country, logo and colour. */
export const DetailsStep = () => {
  const { data: org } = useOrganisationDetails();
  const update = useUpdateOrganisation();
  const [legalName, setLegalName] = useState(org?.legalName ?? "");
  const [country, setCountry] = useState(org?.country ?? null);
  useEffect(() => { setLegalName(org?.legalName ?? ""); setCountry(org?.country ?? null); }, [org?.legalName, org?.country]);
  const dirty = org && (legalName.trim() !== (org.legalName ?? "") || (country ?? null) !== (org.country ?? null));
  return (
    <div className="flex flex-col gap-4">
      <MenuCard as="form" aria-label="Legal details" title="Legal details" subtitle="Used on documents and invoices" bodyClassName="flex flex-col gap-3 min-h-[16rem]"
        onSubmit={(e) => { e.preventDefault(); if (dirty) update.mutate({ body: { legalName: legalName.trim() || null, country } }); }}>
        <Field label="Legal name" maxLength={200} value={legalName} onChange={(e) => setLegalName(e.target.value)} hint="e.g. Acme Fabrication Limited" />
        <RHFComboBox label="Country" value={country} onChange={(v) => setCountry(v ?? null)} options={countryOptions()} placeholder="Choose a country" clearable />
        <FormError error={update.error} />
        <div className="flex justify-end">
          <button type="submit" className={buttonClass.neutral} disabled={!dirty || update.isPending}>{update.isPending ? "Saving…" : "Save details"}</button>
        </div>
      </MenuCard>
      <OrganisationLogo logoPath={org?.settings.logoPath ?? null} canManage />
      <ThemeColourPicker value={org?.settings.themeColour ?? "purple"} canManage />
    </div>
  );
};

/** Step 4: sites and their departments (the same manager as Settings → Organisation). */
export const SitesStep = () => <SitesManager canManage />;

/** Step 5: two-factor authentication for everyone, and for the owner. */
export const SecurityStep = () => {
  const { data: org } = useOrganisationDetails();
  return (
    <div className="flex flex-col gap-4">
      <TwoFactorCard />
      <RequireMfaSetting value={!!org?.settings.requireMfa} canManage />
    </div>
  );
};

/** Step 6: the team. The guided invitation step arrives in the next release; Settings → Users already does it. */
export const TeamStep = () => (
  <MenuCard title="Invite your team" subtitle="People you invite get an email, accept, and see only what their role allows">
    <div className="flex flex-col gap-2 text-sm text-primary-text">
      <p>Add people, choose their roles and departments, and give each a package (seat). You can do it now or at any time later.</p>
      <p>
        <Link to="/Settings/Users" className="text-link-color underline">Open Users &amp; permissions</Link>
      </p>
    </div>
  </MenuCard>
);

const STATUS_TEXT = { done: "Done", skipped: "Skipped", pending: "Not done" };

/** Step 7: what is set up, what is not, and finishing. */
export const ReviewStep = ({ state, labelOf, error }) => (
  <div className="flex flex-col gap-4">
    <MenuCard title="Where things stand" subtitle={state.canFinish ? "Everything required is in place" : "Some required steps are still open"}>
      <ul aria-label="Set-up summary" className="flex flex-col divide-y divide-border-color">
        {state.steps.filter((s) => s.key !== "review").map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="text-primary-text">
              {labelOf(s.key)}
              {s.required && <span className="ml-2 text-xs text-secondary-text">required</span>}
            </span>
            <span className={s.status === "done" ? "text-success-color" : s.status === "skipped" ? "text-secondary-text" : s.required ? "font-medium text-error-color" : "text-secondary-text"}>{STATUS_TEXT[s.status]}</span>
          </li>
        ))}
      </ul>
    </MenuCard>
    {error && <p role="alert" className="text-sm text-error-color">{describeApiError(error)}</p>}
  </div>
);
