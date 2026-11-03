import { useState } from "react";
import Field from "../ui/Field";
import { describeApiError } from "../../lib/api-client";
import { useDepartments, useSites, useStructureMutation } from "../../hooks/useQmsApi";

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
        <Field label="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="w-28" {...codeProps} />
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1 min-w-40" required maxLength={100} />
        {extra}
        <button type="submit" disabled={pending} className={`${smallButton} h-10`}>
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
  const { data, isLoading, error } = useDepartments(site.id, { includeInactive: true });
  const mutation = useStructureMutation();
  const departments = data?.data ?? [];

  return (
    <div className="flex flex-col gap-2 pl-4 border-l border-border-color">
      {isLoading && <p className="text-sm text-secondary-text">Loading departments…</p>}
      {error && <p className="text-sm text-error-color">{describeApiError(error)}</p>}
      {!isLoading && departments.length === 0 && <p className="text-sm text-secondary-text">No departments yet.</p>}
      <ul className="flex flex-col gap-1">
        {departments.map((d) => (
          <li key={d.id} className={`flex items-center justify-between gap-2 text-sm ${d.active ? "text-primary-text" : "text-secondary-text line-through"}`}>
            <span>
              <span className="font-mono">{d.code}</span> — {d.name}
            </span>
            {canManage && (
              <button
                type="button"
                className={smallButton}
                disabled={mutation.isPending}
                onClick={() => mutation.mutate({ resource: "departments", id: d.id, body: { active: !d.active } })}>
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
            mutation.mutate({ resource: "departments", body: { ...fields, siteId: site.id } }, { onSuccess: reset })
          }
        />
      )}
    </div>
  );
};

const SiteRow = ({ site, canManage }) => {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(site.name);
  const [timezone, setTimezone] = useState(site.timezone);
  const mutation = useStructureMutation();

  const save = (e) => {
    e.preventDefault();
    mutation.mutate(
      { resource: "sites", id: site.id, body: { name: name.trim(), timezone: timezone.trim() } },
      { onSuccess: () => setEditing(false) }
    );
  };

  return (
    <li className="rounded-xl border border-border-color p-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`text-left cursor-pointer ${site.active ? "text-primary-text" : "text-secondary-text line-through"}`}>
          <span className="font-mono font-semibold">{site.code}</span> — {site.name}
          <span className="text-secondary-text text-sm"> · {site.timezone}</span>
        </button>
        {canManage && (
          <div className="flex gap-2">
            <button type="button" className={smallButton} onClick={() => setEditing((v) => !v)}>
              {editing ? "Cancel" : "Edit"}
            </button>
            <button
              type="button"
              className={smallButton}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ resource: "sites", id: site.id, body: { active: !site.active } })}>
              {site.active ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        )}
      </div>
      {editing && (
        <form onSubmit={save} aria-label={`Edit site ${site.code}`} className="flex flex-wrap items-end gap-2">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1 min-w-40" required maxLength={100} />
          <Field label="Time zone" value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-56" required hint="IANA name, e.g. Europe/London" />
          <button type="submit" disabled={mutation.isPending} className={`${smallButton} h-10`}>
            Save
          </button>
        </form>
      )}
      {mutation.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(mutation.error)}
        </p>
      )}
      {open && <Departments site={site} canManage={canManage} />}
    </li>
  );
};

/** Sites (and their departments) of the current organisation. Deactivate rather than delete. */
const SitesManager = ({ canManage }) => {
  const { data, isLoading, error } = useSites({ includeInactive: true });
  const mutation = useStructureMutation();
  const sites = data?.data ?? [];

  return (
    <section aria-label="Sites" className="rounded-2xl border border-border-color bg-secondary-bg p-5 flex flex-col gap-4">
      <div>
        <h3 className="text-primary-text text-xl font-semibold">Sites and departments</h3>
        <p className="text-secondary-text text-sm">Select a site to see its departments.</p>
      </div>
      {isLoading && <p className="text-secondary-text">Loading sites…</p>}
      {error && <p className="text-error-color">{describeApiError(error)}</p>}
      <ul className="flex flex-col gap-2">
        {sites.map((site) => (
          <SiteRow key={site.id} site={site} canManage={canManage} />
        ))}
      </ul>
      {canManage && (
        <AddForm
          label="Add site"
          pending={mutation.isPending}
          error={mutation.error}
          onSubmit={(fields, reset) => mutation.mutate({ resource: "sites", body: fields }, { onSuccess: reset })}
        />
      )}
    </section>
  );
};

export default SitesManager;
