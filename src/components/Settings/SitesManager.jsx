import { useState } from "react";
import { CoinsIcon } from "@/components/icons";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import TimeZoneCombo from "../ui/TimeZoneCombo";
import { describeApiError } from "../../lib/api-client";
import MenuCard from "../ui/MenuCard";
import {
  useDepartments,
  useOrganisationDetails,
  useSites,
  useStructureMutation,
} from "../../hooks/useQmsApi";
import { CURRENCY_OPTIONS } from "../../lib/costs";
import { browserTimeZone } from "../../lib/timeZones";
import LoadingScreen from "../ui/LoadingScreen";

const codeProps = {
  required: true,
  pattern: "[A-Za-z0-9][A-Za-z0-9_\\-]{0,19}",
  title: "1–20 letters, digits, - or _",
  maxLength: 20,
};

const smallButton =
  "rounded-lg border border-border-color px-2 py-1 text-sm text-primary-text hover:border-border-dark-color disabled:opacity-50 cursor-pointer";

/** Inline "add" form shared by sites and departments. */
const AddForm = ({ label, onSubmit, pending, error, extra }) => {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ code: code.trim(), name: name.trim() }, () => {
          setCode("");
          setName("");
        });
      }}>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          className="w-28"
          {...codeProps}
        />
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 min-w-40"
          required
          maxLength={100}
        />
        {extra}
        <button
          type="submit"
          disabled={pending}
          className={`${smallButton} h-10`}>
          {pending ? "Adding…" : label}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(error)}
        </p>
      )}
    </form>
  );
};

const Departments = ({ site, canManage }) => {
  const { data, isLoading, error } = useDepartments(site.id, {
    includeInactive: true,
  });
  const mutation = useStructureMutation();
  const departments = data?.data ?? [];

  return (
    <div className="flex flex-col gap-2 pl-4 border-l border-border-color">
      {isLoading && <LoadingScreen size="sm" />}
      {error && (
        <p className="text-sm text-error-color">{describeApiError(error)}</p>
      )}
      {!isLoading && departments.length === 0 && (
        <p className="text-sm text-secondary-text">No departments yet.</p>
      )}
      <ul className="flex flex-col gap-1">
        {departments.map((d) => (
          <li
            key={d.id}
            className={`flex items-center justify-between gap-2 text-sm ${d.active ? "text-primary-text" : "text-secondary-text line-through"}`}>
            <span>
              <span className="font-mono">{d.code}</span> — {d.name}
            </span>
            {canManage && (
              <button
                type="button"
                className={smallButton}
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    resource: "departments",
                    id: d.id,
                    body: { active: !d.active },
                  })
                }>
                {d.active ? "Deactivate" : "Reactivate"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <AddForm
          label="Add department"
          pending={mutation.isPending}
          error={mutation.error}
          onSubmit={(fields, reset) =>
            mutation.mutate(
              { resource: "departments", body: { ...fields, siteId: site.id } },
              { onSuccess: reset },
            )
          }
        />
      )}
    </div>
  );
};

/** Departments being collected for a site that does not exist yet; they are created with it. */
const StagedDepartments = ({ departments, onChange }) => (
  <div className="flex flex-col gap-2 pl-4 border-l border-border-color">
    {departments.length === 0 && <p className="text-sm text-secondary-text">No departments yet. They are created with the site.</p>}
    <ul className="flex flex-col gap-1">
      {departments.map((d) => (
        <li key={d.code} className="flex items-center justify-between gap-2 text-sm text-primary-text">
          <span>
            <span className="font-mono">{d.code}</span> — {d.name}
          </span>
          <button type="button" className={smallButton} onClick={() => onChange(departments.filter((x) => x.code !== d.code))}>
            Remove
          </button>
        </li>
      ))}
    </ul>
    <AddForm
      label="Add department"
      onSubmit={(fields, reset) => {
        if (departments.some((d) => d.code === fields.code)) return;
        onChange([...departments, fields]);
        reset();
      }}
    />
  </div>
);

/**
 * Add or edit a site in a pop-up: code, name, time zone and currency (the default for money entered at the site;
 * a new site starts with the organisation's currency), and the site's departments. Departments of an existing site are
 * saved as they are added; for a new site they are collected and created with it.
 */
const SiteDialog = ({ site, onClose }) => {
  const org = useOrganisationDetails();
  const orgCurrency = org.data?.settings?.baseCurrency ?? "GBP";
  const creating = !site;
  const [code, setCode] = useState(site?.code ?? "");
  const [name, setName] = useState(site?.name ?? "");
  const [timezone, setTimezone] = useState(site?.timezone ?? browserTimeZone() ?? "");
  const [currency, setCurrency] = useState(site?.currency ?? orgCurrency);
  const [staged, setStaged] = useState([]);
  const [failure, setFailure] = useState(null);
  const mutation = useStructureMutation();
  const formId = `site-form-${site?.id ?? "new"}`;

  const save = async (e) => {
    e.preventDefault();
    setFailure(null);
    try {
      if (creating) {
        const created = await mutation.mutateAsync({ resource: "sites", body: { code: code.trim(), name: name.trim(), timezone, currency } });
        for (const d of staged) await mutation.mutateAsync({ resource: "departments", body: { ...d, siteId: created.id } });
      } else {
        await mutation.mutateAsync({ resource: "sites", id: site.id, body: { name: name.trim(), timezone, currency } });
      }
      onClose();
    } catch (error) {
      setFailure(error);
    }
  };

  return (
    <Dialog title={creating ? "Add site" : `Edit site ${site.code}`} onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-5">
        <form id={formId} onSubmit={save} aria-label={creating ? "Add site" : `Edit site ${site.code}`} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={!creating} hint={creating ? "Short code, e.g. MAIN" : "The code cannot be changed"} {...codeProps} />
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          <TimeZoneCombo label="Time zone" value={timezone} onChange={(zone) => setTimezone(zone ?? "")} required />
          <RHFComboBox
            label="Currency"
            icon={CoinsIcon}
            required
            clearable={false}
            sort={false}
            options={CURRENCY_OPTIONS}
            value={currency}
            onChange={(c) => setCurrency(c ?? orgCurrency)}
            hint={`Default for costs and other money entered at this site. The organisation's is ${orgCurrency}.`}
          />
        </form>
        <section aria-label="Departments" className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-primary-text">Departments</h4>
          {creating ? <StagedDepartments departments={staged} onChange={setStaged} /> : <Departments site={site} canManage />}
          {!creating && <p className="text-xs text-secondary-text">Departments are saved as you add them.</p>}
        </section>
        {failure && (
          <p role="alert" className="text-sm text-error-color">
            {describeApiError(failure)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
            {creating ? "Cancel" : "Close"}
          </button>
          <button
            type="submit"
            form={formId}
            disabled={mutation.isPending || !timezone || !currency || name.trim().length === 0 || (creating && code.trim().length === 0)}
            className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
            {mutation.isPending ? "Saving…" : creating ? "Add site" : "Save changes"}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

const SiteRow = ({ site, canManage }) => {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const mutation = useStructureMutation();

  return (
    <li className="rounded-xl border bg-primary-bg border-border-color p-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`text-left cursor-pointer ${site.active ? "text-primary-text" : "text-secondary-text line-through"}`}>
          <span className="font-mono font-semibold">{site.code}</span> —{" "}
          {site.name}
          <span className="text-secondary-text text-sm">
            {" "}
            · {site.timezone} · {site.currency}
          </span>
        </button>
        {canManage && (
          <div className="flex gap-2">
            <button type="button" className={smallButton} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className={smallButton}
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  resource: "sites",
                  id: site.id,
                  body: { active: !site.active },
                })
              }>
              {site.active ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        )}
      </div>
      {mutation.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(mutation.error)}
        </p>
      )}
      {open && <Departments site={site} canManage={canManage} />}
      {editing && <SiteDialog site={site} onClose={() => setEditing(false)} />}
    </li>
  );
};

/** Sites (and their departments) of the current organisation. Deactivate rather than delete. */
const SitesManager = ({ canManage }) => {
  const { data, isLoading, error } = useSites({ includeInactive: true });
  const [adding, setAdding] = useState(false);
  const sites = data?.data ?? [];

  return (
    <MenuCard
      aria-label="Sites"
      title="Sites and departments"
      subtitle="Select a site to see its departments. Edit a site to change its time zone, currency and departments."
      bodyClassName="flex flex-col gap-4">
      {isLoading && <LoadingScreen size="sm" />}
      {error && <p className="text-error-color">{describeApiError(error)}</p>}
      <ul className="flex flex-col gap-2">
        {sites.map((site) => (
          <SiteRow key={site.id} site={site} canManage={canManage} />
        ))}
      </ul>
      {canManage && (
        <div>
          <button type="button" className={`${smallButton} h-9.5`} onClick={() => setAdding(true)}>
            Add site
          </button>
        </div>
      )}
      {adding && <SiteDialog site={null} onClose={() => setAdding(false)} />}
    </MenuCard>
  );
};

export default SitesManager;
