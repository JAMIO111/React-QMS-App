import { useState } from "react";
import { BuildingIcon, ClockIcon, CoinsIcon, MapPinIcon, PlusIcon, Undo2Icon, XIcon } from "@/components/icons";
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
import { isPending } from "../../lib/optimistic";
import { useToast } from "../../contexts/ToastProvider";
import { CURRENCY_OPTIONS } from "../../lib/costs";
import { browserTimeZone } from "../../lib/timeZones";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";

const codeProps = {
  required: true,
  pattern: "[A-Za-z0-9][A-Za-z0-9_\\-]{0,19}",
  title: "1–20 letters, digits, - or _",
  maxLength: 20,
};

const smallButton =
  "min-h-9.5 rounded-lg border border-border-color px-2 py-1 text-sm text-primary-text hover:border-border-dark-color disabled:opacity-50 cursor-pointer";

/** Inline "add" form shared by sites and departments. */
const AddForm = ({ label, onSubmit, error, extra, onCancel }) => {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const fields = { code: code.trim(), name: name.trim() };
        onSubmit(
          fields,
          () => {
            setCode("");
            setName("");
          },
          // Put what was typed back (an optimistic add the server refused).
          () => {
            setCode(fields.code);
            setName(fields.name);
          },
        );
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
        <CTAButton buttonType="submit" type="neutral" size="md">
          {label}
        </CTAButton>
        {onCancel && (
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onCancel}>
            Cancel
          </CTAButton>
        )}
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
            {canManage && !isPending(d.id) && (
              <button
                type="button"
                className={smallButton}
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
          error={mutation.error}
          onSubmit={(fields, reset, restore) => {
            // Optimistic: the department shows in the list at once; a refusal takes it away and puts the typed values back.
            reset();
            mutation.mutate({ resource: "departments", body: { ...fields, siteId: site.id } }, { onError: restore });
          }}
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
 * Add or edit a site in a pop-up: code, name, time zone and currency (what costs at the site are stated in, which locks once costs exist;
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
  const { showToast } = useToast();
  const formId = `site-form-${site?.id ?? "new"}`;

  const save = async (e) => {
    e.preventDefault();
    setFailure(null);
    try {
      if (creating) {
        const created = await mutation.mutateAsync({ resource: "sites", body: { code: code.trim(), name: name.trim(), timezone, currency } });
        for (const d of staged) await mutation.mutateAsync({ resource: "departments", body: { ...d, siteId: created.id } });
      } else {
        // Optimistic: the site's row changes at once and the pop-up closes; a refusal puts it back and says why.
        mutation.mutate(
          { resource: "sites", id: site.id, body: { name: name.trim(), timezone, currency } },
          { onError: (error) => showToast({ type: "error", title: `Site ${site.code} not saved`, message: describeApiError(error) }) },
        );
        onClose();
        return;
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
            hint={`Costs at this site are stated in this currency: other currencies are converted into it, and its dashboard shows it. The organisation's is ${orgCurrency}. It cannot be changed once costs have been recorded here.`}
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
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            {creating ? "Cancel" : "Close"}
          </CTAButton>
          <CTAButton
            buttonType="submit"
            form={formId}
            disabled={(creating && mutation.isPending) || !timezone || !currency || name.trim().length === 0 || (creating && code.trim().length === 0)} loading={creating && mutation.isPending}
            type="main" size="md">
            {creating && mutation.isPending ? "Saving…" : creating ? "Add site" : "Save changes"}
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** The departments people start with: one click makes it, so a new site is never an empty page. */
const SUGGESTED_DEPARTMENTS = [
  { code: "QA", name: "Quality" },
  { code: "PROD", name: "Production" },
  { code: "WH", name: "Warehouse" },
  { code: "ENG", name: "Engineering" },
];

const DepartmentChip = ({ department: d, canManage }) => {
  const mutation = useStructureMutation();
  return (
    <li className="list-none">
      <span className={`inline-flex min-h-9.5 items-center gap-2 rounded-full border border-border-color bg-primary-bg pl-3 text-sm ${canManage && !isPending(d.id) ? "pr-1" : "pr-3"} ${d.active ? "text-primary-text" : "text-secondary-text line-through"}`}>
        <span className="font-mono text-xs font-semibold">{d.code}</span>
        <span>{d.name}</span>
        {!d.active && <span className="text-xs no-underline">(inactive)</span>}
        {canManage && !isPending(d.id) && (
          <button
            type="button"
            aria-label={`${d.active ? "Deactivate" : "Reactivate"} department ${d.name}`}
            title={d.active ? "Deactivate this department" : "Bring this department back"}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-secondary-text hover:bg-secondary-bg hover:text-primary-text"
            onClick={() => mutation.mutate({ resource: "departments", id: d.id, body: { active: !d.active } })}>
            {d.active ? <XIcon className="h-3.5 w-3.5" /> : <Undo2Icon className="h-3.5 w-3.5" />}
          </button>
        )}
      </span>
    </li>
  );
};

/** A site's departments, always on show: the people in it as chips, and an obvious way to add another. */
const DepartmentsOnCard = ({ site, canManage }) => {
  const { data, isLoading, error } = useDepartments(site.id, { includeInactive: true });
  const mutation = useStructureMutation();
  const [adding, setAdding] = useState(false);
  const departments = data?.data ?? [];
  const live = departments.filter((d) => d.active);
  const quickAdd = (fields) => mutation.mutate({ resource: "departments", body: { ...fields, siteId: site.id } });
  const taken = new Set(departments.map((d) => d.code));

  return (
    <div className="flex flex-col gap-3 border-t border-border-color bg-secondary-bg/50 p-4">
      <h4 className="text-sm font-semibold text-primary-text">
        Departments <span className="font-normal text-secondary-text">({live.length})</span>
      </h4>
      {isLoading && <LoadingScreen size="sm" />}
      {error && <p className="text-sm text-error-color">{describeApiError(error)}</p>}
      {!isLoading && departments.length === 0 && (
        <p className="text-sm text-secondary-text">No departments yet. Departments are the teams or areas in this site, so people and records go to the right place.</p>
      )}
      <ul aria-label={`Departments of ${site.name}`} className="flex flex-wrap items-center gap-2 p-0">
        {departments.map((d) => <DepartmentChip key={d.id} department={d} canManage={canManage} />)}
        {canManage && !adding && (
          <li className="list-none">
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex min-h-9.5 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-brand-primary/60 px-3 text-sm font-medium text-brand-primary hover:bg-brand-primary/10">
              <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add department
            </button>
          </li>
        )}
      </ul>
      {canManage && !adding && departments.length === 0 && !isLoading && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-secondary-text">
          Quick add:
          {SUGGESTED_DEPARTMENTS.filter((d) => !taken.has(d.code)).map((d) => (
            <CTAButton key={d.code} buttonType="button" type="neutral" size="md" aria-label={`Quick add ${d.name}`} onClick={() => quickAdd(d)}>
              + {d.name}
            </CTAButton>
          ))}
        </div>
      )}
      {canManage && adding && (
        <AddForm
          label="Add department"
          error={mutation.error}
          onCancel={() => setAdding(false)}
          onSubmit={(fields, reset, restore) => {
            // Optimistic: the department shows at once; a refusal takes it away and puts the typed values back.
            reset();
            mutation.mutate({ resource: "departments", body: { ...fields, siteId: site.id } }, { onError: restore });
          }}
        />
      )}
    </div>
  );
};

/** One site as a card: what it is, where and in which currency it works, and its departments, all visible without opening anything. */
const SiteCard = ({ site, canManage }) => {
  const [editing, setEditing] = useState(false);
  const mutation = useStructureMutation();

  return (
    <li className="list-none overflow-hidden rounded-2xl border border-border-color bg-primary-bg">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-primary/10 text-brand-primary">
          <MapPinIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-border-color bg-secondary-bg px-2 py-0.5 font-mono text-xs font-semibold text-primary-text">{site.code}</span>
            <h3 className={`text-base font-semibold ${site.active ? "text-primary-text" : "text-secondary-text line-through"}`}>{site.name}</h3>
            {!site.active && <span className="rounded-full border border-border-color px-2 py-0.5 text-xs text-secondary-text">Inactive</span>}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-secondary-text">
            <span className="inline-flex items-center gap-1.5"><ClockIcon className="h-3.5 w-3.5" aria-hidden="true" /> <span className="sr-only">Time zone </span>{site.timezone}</span>
            <span className="inline-flex items-center gap-1.5"><CoinsIcon className="h-3.5 w-3.5" aria-hidden="true" /> <span className="sr-only">Currency </span>{site.currency}</span>
          </p>
        </div>
        {canManage && (
          <div className="flex w-full gap-2 sm:w-auto">
            <CTAButton buttonType="button" type="neutral" size="md" aria-label={`Edit site ${site.code}`} onClick={() => setEditing(true)}>
              Edit
            </CTAButton>
            <CTAButton buttonType="button" type="neutral" size="md" aria-label={`${site.active ? "Deactivate" : "Reactivate"} site ${site.code}`}
              onClick={() => mutation.mutate({ resource: "sites", id: site.id, body: { active: !site.active } })}>
              {site.active ? "Deactivate" : "Reactivate"}
            </CTAButton>
          </div>
        )}
      </div>
      {mutation.error && (
        <p role="alert" className="px-4 pb-3 text-sm text-error-color">
          {describeApiError(mutation.error)}
        </p>
      )}
      <DepartmentsOnCard site={site} canManage={canManage} />
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
      subtitle="A site is a place where work happens: a plant, a warehouse, an office. Departments are the teams or areas inside it."
      action={canManage && sites.length > 0 ? (
        <CTAButton buttonType="button" type="main" size="md" onClick={() => setAdding(true)}>
          <PlusIcon className="h-4 w-4" aria-hidden="true" /> Add site
        </CTAButton>
      ) : undefined}
      bodyClassName="flex flex-col gap-4">
      {isLoading && <LoadingScreen size="sm" />}
      {error && <p className="text-error-color">{describeApiError(error)}</p>}
      {!isLoading && !error && sites.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border-color p-8 text-center">
          <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-primary/10 text-brand-primary"><BuildingIcon className="h-6 w-6" /></span>
          <p className="font-semibold text-primary-text">No sites yet</p>
          <p className="max-w-md text-sm text-secondary-text">You need at least one site. Add where you work, then the departments in it.</p>
          {canManage && <CTAButton buttonType="button" type="main" size="lg" onClick={() => setAdding(true)}>Add site</CTAButton>}
        </div>
      )}
      <ul aria-label="Sites list" className="flex flex-col gap-3 p-0">
        {sites.map((site) => (
          <SiteCard key={site.id} site={site} canManage={canManage} />
        ))}
      </ul>
      {adding && <SiteDialog site={null} onClose={() => setAdding(false)} />}
    </MenuCard>
  );
};

export default SitesManager;
