import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { PlusIcon, XIcon } from "@/components/icons";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { useChangeMutation, useChangeTypes } from "../../hooks/useChange";
import { usePartFamilies } from "../../hooks/useProcessControl";
import { changesSince } from "../../lib/editConflicts";
import { LINK_KINDS, linkKindLabel, linksBody, linkWords, sameLink, URGENCIES } from "../../lib/change";
import { FormError, TextAreaField } from "../master-data/shared";
import { MachinePicker, PartPicker, PartyPicker, RemoteComboBox } from "../ncr/Pickers";
import { OrderPicker } from "../production/pickers";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";

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

/** Raise a change, or edit the wording of a draft. */
export const ChangeDialog = ({ existing, draft, onClose, onSaved }) => {
  const mutation = useChangeMutation();
  const types = useChangeTypes();
  const { showToast } = useToast();
  // the change as the dialog opened it: only what the person changes from it is sent, with its version (edit conflicts)
  const [opened] = useState(existing);
  const [title, setTitle] = useState(existing?.title ?? draft?.title ?? "");
  const [typeId, setTypeId] = useState(existing?.type.id ?? draft?.typeId ?? null);
  const [urgency, setUrgency] = useState(existing?.urgency ?? draft?.urgency ?? "normal");
  const [description, setDescription] = useState(existing?.description ?? draft?.description ?? "");
  const [reason, setReason] = useState(existing?.reason ?? draft?.reason ?? "");
  // A change raised from a record keeps that record as its origin and starts with the records it suggests (each can be taken off).
  const source = draft?.source ?? null;
  const [extraLinks, setExtraLinks] = useState(() => draft?.links ?? []);

  const typeOptions = (types.data?.data ?? []).map((t) => ({ value: t.id, label: t.label, hint: t.description ?? (t.needsCustomerApproval ? "Usually needs the customer" : undefined) }));
  // A type switched off since stays on the change that has it.
  if (existing && !typeOptions.some((t) => t.value === existing.type.id)) typeOptions.push({ value: existing.type.id, label: existing.type.label, hint: "Switched off" });
  const ready = title.trim() && typeId;

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { title: title.trim(), typeId, urgency, description: description.trim() || null, reason: reason.trim() || null };
    if (existing) {
      // Changes show at once; a refusal puts the change back and is told in a toast (useChangeMutation).
      mutation.mutate({ action: "update", id: existing.id, body: changesSince(opened, body) });
      onClose();
      return;
    }
    if (source) {
      body.origin = { kind: source.kind, id: source.id };
      body.links = linksBody(extraLinks);
    }
    mutation.mutate(
      { action: "create", body },
      {
        onSuccess: (change) => {
          onSaved?.(change);
          onClose();
        },
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      },
    );
  };

  return (
    <Dialog title={existing ? `Edit ${existing.reference}` : source ? `Raise a change from ${source.reference}` : "Raise a change"} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        {source && (
          <Callout tone="info" title={`Raised from ${source.reference}`}>
            {source.title}. It stays linked to the change{extraLinks.length ? ", which will cover the records below unless you take them off" : ""}.
            {extraLinks.length > 0 && (
              <ul aria-label="It will cover" className="mt-2 flex flex-wrap gap-2">
                {extraLinks.map((l) => (
                  <li key={`${l.kind}:${l.id ?? l.code}`} className="flex items-center gap-1 rounded-full border border-border-color bg-primary-bg px-2 py-0.5 text-xs">
                    <span>
                      {linkKindLabel(l.kind)} {linkWords(l)}
                    </span>
                    <button type="button" aria-label={`Do not cover ${linkWords(l)}`} className="text-secondary-text hover:text-error-color" onClick={() => setExtraLinks((c) => c.filter((x) => x !== l))}>
                      <XIcon className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Callout>
        )}
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. Move the bracket to the new CNC" />
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField label="Type of change" required value={typeId} onChange={setTypeId} options={typeOptions} sort={false} disabled={existing && existing.stage !== "draft"} hint={existing && existing.stage !== "draft" ? "Fixed once the change leaves draft" : undefined} />
          <ComboField label="Urgency" required value={urgency} onChange={(v) => setUrgency(v ?? "normal")} options={URGENCIES} clearable={false} sort={false} />
        </div>
        <TextAreaField label="What is changing" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={4} hint="What will be different afterwards" />
        <TextAreaField label="Why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} rows={3} hint="The problem, request or opportunity behind it" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Raise change"} />
      </form>
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

/** One picker for the chosen kind; `onPick({ id, name })` with what was chosen. */
const TargetPicker = ({ kind, onPick }) => {
  const [value, setValue] = useState(null);
  const label = linkKindLabel(kind);
  const props = {
    label,
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
    case "part":
      return <PartPicker {...props} />;
    case "machine":
      return <MachinePicker {...props} />;
    case "part_family":
      return <FamilyPicker {...props} />;
    default:
      return <OrderPicker {...props} />;
  }
};

/** Change what a draft covers: parts, part families, machines, suppliers, customers, production orders and operations. */
export const LinksDialog = ({ change, onClose }) => {
  const mutation = useChangeMutation();
  const [links, setLinks] = useState(change.links);
  const [kind, setKind] = useState("part");
  const [code, setCode] = useState("");
  const add = (link) => setLinks((current) => (current.some((l) => sameLink(l, link)) ? current : [...current, link]));
  const save = () => {
    // The links show at once; a refusal puts the old ones back and is told in a toast (useChangeMutation).
    mutation.mutate({ action: "setLinks", id: change.id, body: { links: linksBody(links) }, show: { links } });
    onClose();
  };
  return (
    <Dialog title={`What ${change.reference} covers`} onClose={onClose} width="max-w-2xl">
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
                }}
              >
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

/** Cancel a change with a reason (never deleted). */
export const CancelDialog = ({ change, onClose }) => {
  const mutation = useChangeMutation();
  const [reason, setReason] = useState("");
  const send = (e) => {
    e.preventDefault();
    mutation.mutate({ action: "cancel", id: change.id, body: { reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Dialog title={`Cancel ${change.reference}`} onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">It stays on the record with your reason and cannot be reopened. Raise a new change if it comes back.</p>
        <TextAreaField label="Why is it cancelled?" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} required />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={reason.trim().length < 3} label="Cancel the change" type="danger" />
      </form>
    </Dialog>
  );
};
