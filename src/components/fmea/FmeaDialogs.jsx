import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { PlusIcon, XIcon } from "@/components/icons";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { useEmployees } from "../../hooks/useNcr";
import { useFmeaMutation, useFmeaPeople, useFmeas } from "../../hooks/useFmea";
import { useControlPlans, usePartFamilies } from "../../hooks/useProcessControl";
import { changesSince } from "../../lib/editConflicts";
import { FMEA_KINDS, LINK_KINDS, linkKindLabel, linksBody, linkWords, originWords, personValue, sameLink, TEAM_ROLES, teamBody, teamProblem } from "../../lib/fmea";
import { todayIso } from "../../lib/localDate";
import { FormError, TextAreaField } from "../master-data/shared";
import { MachinePicker, PartPicker, PartyPicker, RemoteComboBox } from "../ncr/Pickers";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { employeeOption } from "@/lib/employees";

const Buttons = ({ onClose, pending, disabled, label, type = "main" }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type={type} size="md" disabled={disabled || pending} loading={pending}>
      {label}
    </CTAButton>
  </div>
);

/** Start an FMEA, or edit the details of one: title, scope, customer, owner and how often it is reviewed. The kind is fixed once it is started. */
export const FmeaDialog = ({ existing, draft, onClose, onSaved }) => {
  const mutation = useFmeaMutation();
  const people = useFmeaPeople();
  const { showToast } = useToast();
  // the FMEA as the dialog opened it: only what the person changes from it is sent, with its version (edit conflicts)
  const [opened] = useState(existing);
  const [kind, setKind] = useState(existing?.kind ?? draft?.kind ?? "process");
  const [title, setTitle] = useState(existing?.title ?? draft?.title ?? "");
  const [scopeText, setScopeText] = useState(existing?.scopeText ?? draft?.scopeText ?? "");
  // raised from a record: what it names becomes the scope, and each can be taken off before saving
  const [suggested, setSuggested] = useState(draft?.links ?? []);
  const [customer, setCustomer] = useState(existing?.customer ?? null);
  const [ownerId, setOwnerId] = useState(existing?.owner?.id ?? null);
  const [months, setMonths] = useState(existing?.reviewMonths ? String(existing.reviewMonths) : "");
  const [baseId, setBaseId] = useState(null);
  // A new FMEA can start as a copy of one in force of the same kind (a base the others inherit from); the copy is its own from then on.
  const bases = useFmeas({ status: "active", kind, pageSize: 100 }, { enabled: !existing });
  const baseOptions = (bases.data?.data ?? []).map((f) => ({ value: f.id, label: `${f.number} · ${f.title}`, hint: f.currentLetter ? `Rev ${f.currentLetter}` : undefined }));
  const ownerOptions = (people.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const monthsValid = months === "" || (Number.isInteger(Number(months)) && Number(months) >= 1 && Number(months) <= 120);
  const ready = title.trim() && monthsValid;

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { title: title.trim(), scopeText: scopeText.trim() || null, customerId: customer?.id ?? null, reviewMonths: months === "" ? null : Number(months) };
    if (ownerId) body.ownerId = ownerId;
    if (existing) {
      // Changes show at once; a refusal puts the FMEA back and is told in a toast (useFmeaMutation).
      mutation.mutate({ action: "update", id: existing.id, body: changesSince(opened, body) });
      onClose();
      return;
    }
    mutation.mutate(
      {
        action: "create",
        body: {
          kind,
          ...body,
          ...(baseId ? { baseFmeaId: baseId } : {}),
          ...(draft ? { raisedFrom: { kind: draft.source.kind, id: draft.source.id }, links: suggested.map((l) => ({ kind: l.kind, id: l.id })) } : {}),
        },
      },
      {
        onSuccess: (fmea) => {
          onSaved?.(fmea);
          onClose();
        },
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      },
    );
  };

  return (
    <Dialog title={existing ? `Edit ${existing.number}` : "Start an FMEA"} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        {draft && (
          <Callout tone="info" title={`Raised from ${originWords(draft.source.kind)} ${draft.source.reference}`}>
            It starts with what that record says. You can change any of it, and the FMEA keeps a link back to the record.
          </Callout>
        )}
        <ComboField label="Kind" required value={kind} onChange={(v) => { setKind(v ?? "process"); setBaseId(null); }} options={FMEA_KINDS} clearable={false} sort={false} disabled={!!existing} hint={existing ? "Fixed once the FMEA is started" : undefined} />
        {!existing && (
          <ComboField
            label="Start from an FMEA in force"
            value={baseId}
            onChange={setBaseId}
            options={baseOptions}
            placeholder="Start empty"
            hint="Copies its analysis as a starting point. Yours is then its own: changes do not travel either way."
            clearable
          />
        )}
        {draft && suggested.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-primary-text">It will cover</p>
            <ul aria-label="Suggested scope" className="flex flex-wrap gap-2">
              {suggested.map((l) => (
                <li key={`${l.kind}-${l.id}`} className="inline-flex items-center gap-1 rounded-full border border-border-color bg-secondary-bg px-3 py-1 text-sm text-primary-text">
                  <span className="text-secondary-text">{l.kind === "part_family" ? "Part family" : l.kind.charAt(0).toUpperCase() + l.kind.slice(1)}:</span> {l.label}
                  <button type="button" aria-label={`Remove ${l.label}`} className="ml-1 text-secondary-text hover:text-primary-text" onClick={() => setSuggested(suggested.filter((x) => x !== l))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Machining of the bracket" />
        <TextAreaField label="Scope and intended use" value={scopeText} onChange={(e) => setScopeText(e.target.value)} maxLength={2000} rows={3} hint="What is analysed, and what it is for" />
        <div className="grid gap-3 sm:grid-cols-2">
          <PartyPicker kind="customers" label="Customer" value={customer?.id ?? null} current={customer} onChange={(id, option) => setCustomer(id ? { id, name: option?.name ?? "" } : null)} />
          <ComboField label="Owner" value={ownerId} onChange={setOwnerId} options={ownerOptions} placeholder="You" clearable />
        </div>
        <Field
          label="Review every (months)"
          type="number"
          min={1}
          max={120}
          value={months}
          onChange={(e) => setMonths(e.target.value)}
          hint="Empty: every 12 months"
          error={monthsValid ? undefined : "1 to 120 months"}
        />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Start the FMEA"} />
      </form>
    </Dialog>
  );
};

/** The team: people from the Employees register or members, each with a role; one lead. */
export const TeamDialog = ({ revision, onClose }) => {
  const mutation = useFmeaMutation();
  const people = useFmeaPeople();
  const employees = useEmployees();
  const [rows, setRows] = useState(() => revision.team.map((m) => ({ person: `${m.kind === "employee" ? "e" : "u"}:${m.personId}`, role: m.role })));
  const options = [
    ...(people.data ?? []).map((p) => ({ value: `u:${p.id}`, label: p.name, hint: "Member", avatar: { name: p.name, path: p.avatarPath ?? null } })),
    ...(employees.data ?? []).filter((e) => e.active).map((e) => employeeOption(e, { as: "field", value: `e:${e.id}`, hint: e.jobTitle ?? "Employee" })),
  ];
  // Someone already on the team stays offered even if they are no longer in the lists.
  revision.team.forEach((m) => {
    const value = personValue(m);
    if (!options.some((o) => o.value === value)) options.push({ value, label: m.name, hint: m.kind === "employee" ? "Employee" : "Member" });
  });
  const problem = teamProblem(rows);
  const set = (i, patch) => setRows((c) => c.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const save = () => {
    const names = Object.fromEntries(options.map((o) => [o.value, o]));
    const show = {
      team: rows.map((r, n) => ({ id: `pending-${n}`, kind: r.person.startsWith("e:") ? "employee" : "member", personId: r.person.slice(2), name: names[r.person]?.label ?? "", jobTitle: null, role: r.role })),
    };
    // The team shows at once; a refusal puts the old one back and is told in a toast (useFmeaMutation).
    mutation.mutate({ action: "setTeam", id: revision.id, body: { team: teamBody(rows) }, show });
    onClose();
  };
  return (
    <Dialog title="The team" onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">A cross-functional team: name the lead and the people who know the design or the process. People from the Employees register need no sign-in.</p>
        {rows.length === 0 && <p className="text-sm text-secondary-text">Nobody yet.</p>}
        <ul aria-label="Team" className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <li key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_12rem_auto]">
              <ComboField label={`Person ${i + 1}`} value={r.person || null} onChange={(v) => set(i, { person: v ?? "" })} options={options} placeholder="Choose a person" />
              <ComboField label="Role" value={r.role} onChange={(v) => set(i, { role: v ?? "other" })} options={TEAM_ROLES} clearable={false} sort={false} />
              <button type="button" aria-label={`Remove person ${i + 1}`} className="mb-1 rounded p-2 text-secondary-text hover:text-error-color" onClick={() => setRows((c) => c.filter((_, n) => n !== i))}>
                <XIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div>
          <CTAButton type="neutral" size="md" icon={PlusIcon} onClick={() => setRows((c) => [...c, { person: "", role: c.some((r) => r.role === "lead") ? "other" : "lead" }])}>
            Add a person
          </CTAButton>
        </div>
        {problem && <p role="alert" className="text-sm text-error-color">{problem}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="main" size="md" disabled={!!problem} loading={mutation.isPending} onClick={save}>
            Save
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

const FamilyPicker = ({ value, onChange, label }) => {
  const [q, setSearch] = useDebouncedSearch();
  const families = usePartFamilies({ q });
  return (
    <RemoteComboBox
      label={label}
      placeholder="Search a part family…"
      value={value}
      onChange={onChange}
      items={(families.data?.items ?? []).map((f) => ({ id: f.id, name: f.name, hint: f.code }))}
      isFetching={families.isFetching}
      onSearch={setSearch}
    />
  );
};

const PlanPicker = ({ value, onChange, label }) => {
  const [q, setSearch] = useDebouncedSearch();
  const plans = useControlPlans({ q, status: "", active: "all", pageSize: 20 });
  return (
    <RemoteComboBox
      label={label}
      placeholder="Search a control plan…"
      value={value}
      onChange={onChange}
      items={(plans.data?.data ?? []).map((p) => ({ id: p.id, name: p.title, hint: p.planCode }))}
      isFetching={plans.isFetching}
      onSearch={setSearch}
    />
  );
};

/** One picker for the chosen kind; `onPick({ id, name })` with what was chosen. */
const TargetPicker = ({ kind, onPick }) => {
  const [value, setValue] = useState(null);
  const props = {
    label: linkKindLabel(kind),
    value,
    onChange: (id, option) => {
      setValue(id);
      if (id) onPick({ id, name: option?.name });
    },
  };
  switch (kind) {
    case "supplier":
      return <PartyPicker kind="suppliers" {...props} />;
    case "customer":
      return <PartyPicker kind="customers" {...props} />;
    case "machine":
      return <MachinePicker {...props} />;
    case "part_family":
      return <FamilyPicker {...props} />;
    case "control_plan":
      return <PlanPicker {...props} />;
    default:
      return <PartPicker {...props} />;
  }
};

/** Change what a draft covers: parts, part families, control plans, machines, suppliers, customers and operations. */
export const LinksDialog = ({ revision, onClose }) => {
  const mutation = useFmeaMutation();
  const [links, setLinks] = useState(revision.links);
  const [kind, setKind] = useState("part");
  const [code, setCode] = useState("");
  const add = (link) => setLinks((current) => (current.some((l) => sameLink(l, link)) ? current : [...current, link]));
  const save = () => {
    // The links show at once; a refusal puts the old ones back and is told in a toast (useFmeaMutation).
    mutation.mutate({ action: "setLinks", id: revision.id, body: { links: linksBody(links) }, show: { links } });
    onClose();
  };
  return (
    <Dialog title="What the FMEA covers" onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        {links.length === 0 ? (
          <p className="text-sm text-secondary-text">Nothing yet.</p>
        ) : (
          <ul aria-label="Covers" className="flex flex-col gap-2">
            {links.map((l) => (
              <li key={`${l.kind}:${l.id ?? l.code}`} className="flex items-center gap-2 rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-secondary-text">{linkKindLabel(l.kind)}</span>
                <span className="min-w-0 flex-1 truncate text-primary-text">{linkWords(l)}</span>
                <button type="button" aria-label={`Remove ${linkWords(l)}`} className="rounded p-1 text-secondary-text hover:text-error-color" onClick={() => setLinks((c) => c.filter((x) => !sameLink(x, l)))}>
                  <XIcon className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 rounded-xl border border-dashed border-border-color p-3 sm:grid-cols-[12rem_1fr]">
          <ComboField label="Add" value={kind} onChange={(v) => setKind(v ?? "part")} options={LINK_KINDS} clearable={false} sort={false} />
          {kind === "operation_code" ? (
            <div className="flex items-end gap-2">
              <Field label="Operation code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} className="flex-1" />
              <CTAButton
                type="neutral"
                size="md"
                icon={PlusIcon}
                disabled={!code.trim()}
                onClick={() => {
                  add({ kind: "operation_code", id: null, code: code.trim(), reference: code.trim(), name: null, readable: true });
                  setCode("");
                }}>
                Add
              </CTAButton>
            </div>
          ) : (
            <TargetPicker key={kind} kind={kind} onPick={({ id, name }) => add({ kind, id, code: null, reference: name ?? null, name: null, readable: true })} />
          )}
        </div>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="main" size="md" loading={mutation.isPending} onClick={save}>
            Save
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** Name who approves the draft: a member who holds the approve permission and is not the preparer. */
export const ApproverDialog = ({ revision, onClose }) => {
  const mutation = useFmeaMutation();
  const people = useFmeaPeople();
  const [approverId, setApproverId] = useState(revision.approver?.id ?? null);
  const options = (people.data ?? [])
    .filter((p) => p.canApprove && p.id !== revision.author?.id)
    .map((p) => ({ value: p.id, label: p.name }));
  const save = (e) => {
    e.preventDefault();
    const chosen = options.find((o) => o.value === approverId);
    mutation.mutate({ action: "setApprover", id: revision.id, body: { approverId }, show: { approver: chosen ? { id: chosen.value, name: chosen.label } : null } });
    onClose();
  };
  return (
    <Dialog title="Who approves it" onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Someone who holds the approve permission and is not the person who prepared the revision.</p>
        <ComboField label="Approver" required value={approverId} onChange={setApproverId} options={options} placeholder="Choose the approver" clearable />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} label="Save" />
      </form>
    </Dialog>
  );
};

/** Approve a revision: it takes effect on the date chosen (today: at once, and the one in force is superseded). */
export const ApproveDialog = ({ revision, onClose }) => {
  const mutation = useFmeaMutation();
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [comment, setComment] = useState("");
  const send = (e) => {
    e.preventDefault();
    mutation.mutate({ action: "approve", id: revision.id, body: { effectiveFrom, comment: comment.trim() || null } }, { onSuccess: onClose });
  };
  return (
    <Dialog title={`Approve ${revision.fmea.number} ${revision.letter ? `rev ${revision.letter}` : ""}`} onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <RHFDatePickerPopout label="Takes effect on" required value={effectiveFrom} onChange={(v) => setEffectiveFrom(v ?? "")} valueFormat="iso" minDate={new Date(`${todayIso()}T00:00:00`)} />
        <p className="text-sm text-secondary-text">
          {effectiveFrom === todayIso()
            ? "It is in force as soon as you approve it, and the revision in force now is superseded."
            : "Until then the revision in force now stays in force; on that day it is superseded."}
        </p>
        <Field label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} hint="Optional" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!effectiveFrom} label="Approve" />
      </form>
    </Dialog>
  );
};

/** One note or reason, sent with a command: sending back, recalling, discarding and withdrawing. */
export const ReasonDialog = ({ title, intro, label, button, action, id, field = "reason", tone = "main", onClose }) => {
  const mutation = useFmeaMutation();
  const [text, setText] = useState("");
  const send = (e) => {
    e.preventDefault();
    mutation.mutate({ action, id, body: { [field]: text.trim() } }, { onSuccess: onClose });
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        {intro && <p className="text-sm text-secondary-text">{intro}</p>}
        <TextAreaField label={label} value={text} onChange={(e) => setText(e.target.value)} maxLength={field === "comment" ? 2000 : 500} rows={3} required />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={text.trim().length < 3} label={button} type={tone} />
      </form>
    </Dialog>
  );
};
