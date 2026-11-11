import { useState } from "react";
import { CheckIcon, UserPlusIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useCompetenceSkills } from "../../hooks/useCompetence";
import { useDocumentMutation, useDocumentRecipients, useDocumentSigners, useSaveDraft, useSetRestricted } from "../../hooks/useDocuments";
import { useAllDepartments, useMembers, usePermissions, useRoles } from "../../hooks/useQmsApi";
import { formatDay } from "../../lib/documents";
import { todayIso } from "../../lib/localDate";
import { FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";

const KIND_LABEL = { department: "Department", role: "Role", person: "Person" };
const asBody = (t) => (t.kind === "department" ? { departmentId: t.refId } : t.kind === "role" ? { roleId: t.refId } : { membershipId: t.refId });

const Chips = ({ label, items, onRemove }) =>
  items.length > 0 && (
    <ul aria-label={label} className="flex flex-wrap gap-2">
      {items.map((t) => (
        <li key={`${t.kind}:${t.refId}`} className="flex items-center gap-1 rounded-full bg-primary-bg px-3 py-1 text-sm text-primary-text">
          <span className="text-secondary-text">{KIND_LABEL[t.kind] ?? t.kind}:</span> {t.label}
          {onRemove && (
            <button type="button" aria-label={`Remove ${t.label}`} onClick={() => onRemove(t)} className="text-icon-color hover:text-error-color">
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );

/**
 * Who must read the document (departments, roles, people) and whether it is restricted to them. The list is kept on the document; each revision
 * asks the people it reaches on the day it takes effect.
 */
export const ReadersCard = ({ doc }) => {
  const { can } = usePermissions();
  const editable = doc.canManage;
  const departments = useAllDepartments();
  const roles = useRoles();
  const members = useMembers({ enabled: editable && can("members.read") });
  const mutation = useDocumentMutation();
  const restrict = useSetRestricted(doc.id);
  const { showToast } = useToast();
  const fail = (title) => (err) => showToast({ type: "error", title, message: describeApiError(err) });
  const save = (targets) => mutation.mutate({ action: "setReaders", id: doc.id, body: { targets: targets.map(asBody) } }, { onError: fail("Readers not saved") });
  const chosen = new Set(doc.targets.map((t) => `${t.kind}:${t.refId}`));
  const opts = (kind, list) => list.filter((o) => !chosen.has(`${kind}:${o.value}`));
  const deptOptions = opts("department", (departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name, hint: d.code })));
  const roleOptions = opts("role", (roles.data?.data ?? []).map((r) => ({ value: r.id, label: r.name })));
  const personOptions = opts(
    "person",
    (members.data?.data ?? []).filter((m) => m.status === "active").map((m) => ({ value: m.membershipId, label: [m.firstName, m.surname].filter(Boolean).join(" ") || m.email })),
  );
  const add = (kind, value, list) => value && save([...doc.targets, { kind, refId: value, label: list.find((o) => o.value === value)?.label ?? "" }]);

  return (
    <MenuCard title="Readers" subtitle="Who must read it. Each new revision asks them again on the day it takes effect.">
      <div className="flex flex-col gap-3">
        {doc.targets.length === 0 && <p className="text-sm text-secondary-text">Nobody is asked to read it yet.</p>}
        <Chips label="Readers" items={doc.targets} onRemove={editable ? (t) => save(doc.targets.filter((x) => x !== t)) : null} />
        {editable && (
          <div className="grid gap-3 sm:grid-cols-3">
            <ComboField label="Add a department" value={null} onChange={(v) => add("department", v, deptOptions)} options={deptOptions} placeholder="Its members" />
            <ComboField label="Add a role" value={null} onChange={(v) => add("role", v, roleOptions)} options={roleOptions} placeholder="Everyone holding it" />
            {can("members.read") && <ComboField label="Add a person" value={null} onChange={(v) => add("person", v, personOptions)} options={personOptions} placeholder="One person" />}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-border-color pt-3">
          <div className="flex flex-col">
            <span className="text-sm font-medium text-primary-text">Restricted</span>
            <span className="text-sm text-secondary-text">Only its readers and document managers can open it.</span>
          </div>
          <Switch
            checked={doc.restricted}
            disabled={!editable}
            onChange={(e) => restrict.mutate(e.target.checked, { onError: fail("Not changed") })}>
            <span className="sr-only">Restricted</span>
          </Switch>
        </div>
        {doc.status === "active" && (
          <p className="text-sm text-secondary-text">
            Rev {doc.currentRevision?.letter}: {doc.readers.acknowledged} of {doc.readers.total} acknowledged
            {doc.readers.overdue ? `, ${doc.readers.overdue} overdue` : ""}.
          </p>
        )}
      </div>
    </MenuCard>
  );
};

/** The skills a document trains: acknowledging it shows on the reader's competence record as evidence (never as an assessment). */
export const SkillsCard = ({ doc }) => {
  const { can } = usePermissions();
  const editable = doc.canManage;
  const skills = useCompetenceSkills({ enabled: editable && can("competence.read") });
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  if (!editable && doc.skills.length === 0) return null;
  const ids = doc.skills.map((k) => k.id);
  const save = (next) =>
    mutation.mutate({ action: "setSkills", id: doc.id, body: { skillIds: next } }, { onError: (err) => showToast({ type: "error", title: "Skills not saved", message: describeApiError(err) }) });
  const options = (skills.data?.data ?? []).filter((k) => !ids.includes(k.id)).map((k) => ({ value: k.id, label: k.name, hint: k.code }));
  return (
    <MenuCard title="Skills it trains" subtitle="Reading and acknowledging it counts as evidence on the person's competence record. It never assesses anyone.">
      <div className="flex flex-col gap-3">
        {doc.skills.length > 0 ? (
          <ul aria-label="Skills it trains" className="flex flex-wrap gap-2">
            {doc.skills.map((k) => (
              <li key={k.id} className="flex items-center gap-1 rounded-full bg-primary-bg px-3 py-1 text-sm text-primary-text">
                {k.name}
                {editable && (
                  <button type="button" aria-label={`Remove ${k.name}`} onClick={() => save(ids.filter((x) => x !== k.id))} className="text-icon-color hover:text-error-color">
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-secondary-text">None.</p>
        )}
        {editable && can("competence.read") && <ComboField label="Add a skill" value={null} onChange={(v) => v && save([...ids, v])} options={options} placeholder="Choose a skill" />}
      </div>
    </MenuCard>
  );
};

/** How long readers have to acknowledge a revision once it takes effect (set on the draft, saved on leaving the field). */
export const AcknowledgeDaysField = ({ revision }) => {
  const save = useSaveDraft(revision.id);
  const { showToast } = useToast();
  const [value, setValue] = useState(revision.acknowledgeWithinDays ?? "");
  if (!revision.canEdit) {
    return (
      <p className="text-sm text-secondary-text">
        {revision.acknowledgeWithinDays ? `Readers have ${revision.acknowledgeWithinDays} days to acknowledge it once it takes effect.` : "Readers have no deadline."}
      </p>
    );
  }
  const commit = () => {
    const n = value === "" ? null : Number(value);
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 365)) return;
    if (n === (revision.acknowledgeWithinDays ?? null)) return;
    save.mutate({ acknowledgeWithinDays: n }, { onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  };
  return (
    <Field
      label="Days readers have to acknowledge it"
      type="number"
      min="1"
      max="365"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      hint="Counted from the day it takes effect. Leave empty for no deadline."
    />
  );
};

const AcknowledgeDialog = ({ revision, onClose }) => {
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  const save = (e) => {
    e.preventDefault();
    mutation.mutate(
      { action: "acknowledge", id: revision.id, body: { note: note.trim() || undefined } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not acknowledged", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={`Acknowledge ${revision.document.number} rev ${revision.letter}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">You confirm you have read and understood this revision.</p>
        <Field label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} hint="Optional" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="success" size="md" icon={CheckIcon} disabled={mutation.isPending} loading={mutation.isPending}>
            I have read it
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** For a reader of the revision in force: acknowledge it, or when they did. */
export const AcknowledgeCard = ({ revision }) => {
  const [open, setOpen] = useState(false);
  const r = revision.myReading;
  if (!r) return null;
  if (r.acknowledgedAt) {
    return (
      <Callout tone="success" title="You acknowledged it">
        {formatDay(r.acknowledgedAt)}
        {r.note ? ` · “${r.note}”` : ""}
      </Callout>
    );
  }
  if (revision.status !== "effective") return null;
  const overdue = r.dueOn && r.dueOn < todayIso();
  return (
    <Callout
      tone={overdue ? "error" : "warning"}
      title={overdue ? "Overdue: please read and acknowledge it" : "Please read and acknowledge it"}
      action={
        <CTAButton type="success" icon={CheckIcon} onClick={() => setOpen(true)}>
          Acknowledge
        </CTAButton>
      }>
      {r.dueOn ? `By ${formatDay(r.dueOn)}.` : "You were asked to read this revision."}
      {open && <AcknowledgeDialog revision={revision} onClose={() => setOpen(false)} />}
    </Callout>
  );
};

const AddReaderDialog = ({ revision, recipients, onClose }) => {
  const people = useDocumentSigners();
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const [userId, setUserId] = useState(null);
  const already = new Set(recipients.map((x) => x.person.id));
  const options = (people.data ?? []).filter((p) => !already.has(p.id)).map((p) => ({ value: p.id, label: p.name }));
  const save = (e) => {
    e.preventDefault();
    if (!userId) return;
    mutation.mutate({ action: "addRecipient", id: revision.id, body: { userId } }, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not added", message: describeApiError(err) }) });
  };
  return (
    <Dialog title="Ask someone else to read it" onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <ComboField label="Person" required value={userId} onChange={setUserId} options={options} placeholder="Choose a person" />
        <p className="text-sm text-secondary-text">They are asked to read this revision now, with the same number of days to acknowledge it.</p>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!userId || mutation.isPending} loading={mutation.isPending}>
            Add
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** For document managers: who was asked to read this revision, who has viewed and acknowledged it, and who is overdue. */
export const RecipientsCard = ({ revision }) => {
  const manage = revision.document.canManage;
  const query = useDocumentRecipients(revision.id, { enabled: manage && ["effective", "superseded", "withdrawn"].includes(revision.status) });
  const [adding, setAdding] = useState(false);
  if (!manage || !["effective", "superseded", "withdrawn"].includes(revision.status)) return null;
  const list = query.data ?? [];
  const s = revision.readers;
  return (
    <MenuCard
      title="Readers of this revision"
      subtitle={`${s.acknowledged} of ${s.total} acknowledged · ${s.viewed} viewed${s.overdue ? ` · ${s.overdue} overdue` : ""}`}
      action={
        revision.status === "effective" && (
          <CTAButton type="neutral" icon={UserPlusIcon} onClick={() => setAdding(true)}>
            Add a reader
          </CTAButton>
        )
      }>
      {query.isLoading ? (
        <LoadingScreen />
      ) : list.length === 0 ? (
        <p className="text-sm text-secondary-text">Nobody was asked to read it.</p>
      ) : (
        <table className="min-w-full text-sm" aria-label="Readers">
          <thead>
            <tr className="text-left text-secondary-text">
              {["Person", "Reached via", "Due", "Viewed", "Acknowledged"].map((h) => (
                <th key={h} scope="col" className="py-1 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.id} className="border-t border-border-color">
                <td className="py-1.5 pr-3 text-primary-text">{x.person.name}</td>
                <td className="py-1.5 pr-3 text-secondary-text">{x.reachedVia.join(", ")}</td>
                <td className={`py-1.5 pr-3 ${x.overdue ? "font-medium text-error-color" : "text-secondary-text"}`}>
                  {x.dueOn ? formatDay(x.dueOn) : "—"}
                  {x.overdue ? " (overdue)" : ""}
                </td>
                <td className="py-1.5 pr-3 text-secondary-text">{x.viewedAt ? formatDay(x.viewedAt) : "—"}</td>
                <td className="py-1.5 pr-3 text-secondary-text">
                  {x.acknowledgedAt ? formatDay(x.acknowledgedAt) : "—"}
                  {x.note ? ` · “${x.note}”` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && <AddReaderDialog revision={revision} recipients={list} onClose={() => setAdding(false)} />}
    </MenuCard>
  );
};
