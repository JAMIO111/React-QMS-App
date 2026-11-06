import { useState } from "react";
import Dialog from "../../ui/Dialog";
import Field from "../../ui/Field";
import MenuCard from "../../ui/MenuCard";
import RHFComboBox from "../../ui/RHFComboBox";
import { useCapaMutation, useCapaPeople } from "../../../hooks/useCapa";
import { TEAM_ROLES, roleLabel } from "../../../lib/capa";
import { FormError, buttonClass } from "../../master-data/shared";

const roleOptions = (keys) => keys.map((k) => ({ id: k, name: TEAM_ROLES[k].label, hint: TEAM_ROLES[k].hint }));
const MEMBER_ROLES = roleOptions(["leader", "champion", "member"]);
const ALL_ROLES = roleOptions(["leader", "champion", "member", "supplier_contact", "customer_contact"]);

const ExternalDialog = ({ capa, onClose }) => {
  const mutation = useCapaMutation();
  const [form, setForm] = useState({ externalName: "", externalCompany: "", externalEmail: "", role: "supplier_contact" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog title="Add an external contact" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const { externalName, externalCompany, externalEmail, role } = form;
          mutation.mutate(
            { action: "addTeam", id: capa.id, body: { externalName: externalName.trim(), role, ...(externalCompany.trim() ? { externalCompany: externalCompany.trim() } : {}), ...(externalEmail.trim() ? { externalEmail: externalEmail.trim() } : {}) } },
            { onSuccess: onClose },
          );
        }}>
        <p className="text-sm text-secondary-text">For someone with no login, such as a supplier or customer representative. They are listed on the 8D and can own actions, but cannot sign in.</p>
        <Field label="Name" value={form.externalName} onChange={set("externalName")} required maxLength={120} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Company" value={form.externalCompany} onChange={set("externalCompany")} maxLength={120} />
          <Field label="Email" value={form.externalEmail} onChange={set("externalEmail")} maxLength={200} />
        </div>
        <RHFComboBox label="Role" value={form.role} onChange={(v) => setForm((f) => ({ ...f, role: v ?? "member" }))} options={ALL_ROLES} sort={false} clearable={false} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={mutation.isPending || !form.externalName.trim()}>{mutation.isPending ? "Adding…" : "Add contact"}</button>
        </div>
      </form>
    </Dialog>
  );
};

/** D1: who is on the team and in what role. Members of the organisation and external contacts. */
const D1Team = ({ capa, editable }) => {
  const mutation = useCapaMutation();
  const people = useCapaPeople({ enabled: editable });
  const [adding, setAdding] = useState({ membershipId: null, role: "member" });
  const [external, setExternal] = useState(false);
  const active = capa.team.filter((t) => !t.endedAt);
  const left = capa.team.filter((t) => t.endedAt);
  const onTeam = new Set(active.map((t) => t.membershipId));
  const choices = (people.data ?? []).filter((p) => !onTeam.has(p.membershipId)).map((p) => ({ id: p.membershipId, name: p.name }));

  return (
    <MenuCard title="The team" subtitle={`${active.length} ${active.length === 1 ? "person" : "people"}`}
      action={editable ? <button type="button" className={buttonClass.neutral} onClick={() => { mutation.reset(); setExternal(true); }}>Add an external contact</button> : undefined}
      bodyClassName="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-border-color" aria-label="Team members">
        {active.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary/15 text-sm font-semibold text-primary-text">
                {t.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-col text-sm">
                <span className="truncate font-medium text-primary-text">
                  {t.name}
                  {t.external && <span className="ml-2 rounded-full border border-border-color px-1.5 py-0.5 text-xs font-normal text-secondary-text">External</span>}
                </span>
                {(t.company || t.email) && <span className="truncate text-xs text-secondary-text">{[t.company, t.email].filter(Boolean).join(" · ")}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {editable ? (
                <RHFComboBox label={`Role of ${t.name}`} value={t.role} onChange={(v) => v && v !== t.role && mutation.mutate({ action: "updateTeam", id: t.id, body: { role: v } })}
                  options={t.external ? ALL_ROLES : MEMBER_ROLES} sort={false} clearable={false} className="w-48" />
              ) : (
                <span className="rounded-full bg-secondary-bg px-2 py-0.5 text-xs text-primary-text">{roleLabel(t.role)}</span>
              )}
              {editable && (
                <button type="button" className={buttonClass.neutral} aria-label={`Remove ${t.name} from the team`} onClick={() => mutation.mutate({ action: "updateTeam", id: t.id, body: { ended: true } })}>Remove</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <FormError error={mutation.error} />
      {editable && (
        <form
          className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_12rem_auto]"
          aria-label="Add a team member"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding.membershipId) mutation.mutate({ action: "addTeam", id: capa.id, body: { membershipId: adding.membershipId, role: adding.role } }, { onSuccess: () => setAdding({ membershipId: null, role: "member" }) });
          }}>
          <RHFComboBox label="Add a member of the organisation" required value={adding.membershipId} onChange={(v) => setAdding((a) => ({ ...a, membershipId: v }))} options={choices} placeholder="Choose a person" />
          <RHFComboBox label="Role" value={adding.role} onChange={(v) => setAdding((a) => ({ ...a, role: v ?? "member" }))} options={MEMBER_ROLES} sort={false} clearable={false} />
          <button type="submit" className={buttonClass.primary} disabled={!adding.membershipId || mutation.isPending}>Add</button>
        </form>
      )}
      {left.length > 0 && (
        <details className="text-sm text-secondary-text">
          <summary className="cursor-pointer">{left.length} left the team</summary>
          <ul className="mt-1 flex flex-col gap-1">{left.map((t) => <li key={t.id}>{t.name} · {roleLabel(t.role)}</li>)}</ul>
        </details>
      )}
      {external && <ExternalDialog capa={capa} onClose={() => setExternal(false)} />}
    </MenuCard>
  );
};

export default D1Team;
