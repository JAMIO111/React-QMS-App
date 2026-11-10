import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { useToast } from "../../contexts/ToastProvider";
import { useCustomFieldMutation, useCustomFields } from "../../hooks/useCustomFields";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import {
  CUSTOM_FIELD_ENTITIES,
  FIELD_TYPES,
  entityLabel,
  fieldBody,
  fieldProblems,
  fieldToForm,
  fieldTypeLabel,
  isListType,
  optionKeyFromLabel,
  requiredChoices,
  requiredLabel,
} from "../../lib/customFields";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import RowActionsMenu from "../ui/RowActionsMenu";
import Switch from "../ui/Switch";
import { FormError, TextAreaField } from "../master-data/shared";

/** The list of options of a choice field: labels editable, saved options switched off (never removed), new ones removable. */
const OptionsEditor = ({ options, onChange }) => {
  const [draft, setDraft] = useState("");
  const set = (i, patch) => onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const add = () => {
    const label = draft.trim();
    if (!label) return;
    onChange([...options, { key: optionKeyFromLabel(label, options.map((o) => o.key)), label, active: true, saved: false }]);
    setDraft("");
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-secondary-text" data-required>
        Options
      </legend>
      {options.length === 0 && <p className="text-xs text-secondary-text">No options yet. Add the first one below.</p>}
      <ul className="flex flex-col gap-1.5" aria-label="Options">
        {options.map((o, i) => (
          <li key={o.key} className="flex items-center gap-2">
            <input
              aria-label={`Option ${i + 1}`}
              className="min-w-0 flex-1 rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm text-primary-text focus:outline-none focus:border-brand-primary"
              value={o.label}
              maxLength={80}
              onChange={(e) => set(i, { label: e.target.value })}
            />
            {o.saved ? (
              <Switch checked={o.active !== false} onChange={(e) => set(i, { active: e.target.checked })} aria-label={`${o.label || "Option"} can be chosen`} />
            ) : (
              <button type="button" aria-label={`Remove ${o.label || "option"}`} className="cursor-pointer rounded-lg p-1.5 text-secondary-text hover:bg-border-color/50" onClick={() => onChange(options.filter((_, j) => j !== i))}>
                <XIcon />
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <input
          aria-label="New option"
          placeholder="Add an option"
          className="min-w-0 flex-1 rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm text-primary-text focus:outline-none focus:border-brand-primary"
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <CTAButton type="secondary" size="md" onClick={add} disabled={!draft.trim()}>
          Add
        </CTAButton>
      </div>
      {options.some((o) => o.saved) && <p className="text-xs text-secondary-text">A saved option cannot be removed: switch it off so it can no longer be chosen. Records that hold it keep it.</p>}
    </fieldset>
  );
};

/** Add a field, or change one. The kind of record and the type are fixed once a field exists. */
const FieldDialog = ({ entityType, stages, existing, onClose }) => {
  const mutation = useCustomFieldMutation();
  const [form, setForm] = useState(() => fieldToForm(existing, entityType));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const problems = fieldProblems(form);
  const creating = !existing;

  const save = (e) => {
    e.preventDefault();
    if (problems.length) return;
    const body = fieldBody(form, { creating });
    mutation.mutate(creating ? { action: "create", body } : { action: "update", id: existing.id, body }, { onSuccess: () => onClose() });
  };

  return (
    <Dialog title={creating ? `Add a field to ${entityLabel(entityType).toLowerCase()}` : `Edit ${existing.label}`} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label" required value={form.label} maxLength={80} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Customer drawing number" />
          <ComboField
            label="Type"
            required
            disabled={!creating}
            value={form.fieldType}
            onChange={(v) => set({ fieldType: v ?? "text" })}
            options={FIELD_TYPES}
            hint={creating ? FIELD_TYPES.find((t) => t.value === form.fieldType)?.hint : "The type cannot change once a field exists. Retire it and add a new one instead."}
          />
          <Field label="Section" value={form.section} maxLength={60} onChange={(e) => set({ section: e.target.value })} placeholder="e.g. Customer" hint="Fields with the same section are shown together." />
          <ComboField label="Required" required value={form.requiredAt} onChange={(v) => set({ requiredAt: v ?? "never" })} options={requiredChoices(stages)} hint="Records that already exist are never blocked; the rule applies to new records and when a record moves on." />
        </div>
        <TextAreaField label="Help text" rows={2} value={form.helpText} maxLength={500} onChange={(e) => set({ helpText: e.target.value })} hint="Shown under the field to explain what to enter." />
        {form.fieldType === "number" && (
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Decimal places" type="number" min={0} max={6} value={form.decimals} onChange={(e) => set({ decimals: e.target.value })} />
            <Field label="Unit" value={form.unit} maxLength={20} onChange={(e) => set({ unit: e.target.value })} placeholder="e.g. kg" />
            <Field label="Lowest" type="number" value={form.min} onChange={(e) => set({ min: e.target.value })} />
            <Field label="Highest" type="number" value={form.max} onChange={(e) => set({ max: e.target.value })} />
          </div>
        )}
        {isListType(form.fieldType) && <OptionsEditor options={form.options} onChange={(options) => set({ options })} />}
        {problems.length > 0 && form.label && (
          <ul className="list-disc pl-5 text-xs text-secondary-text" aria-label="Still needed">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton onClick={onClose} type="neutral" size="md">
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={problems.length > 0 || mutation.isPending} loading={mutation.isPending}>
            {creating ? "Add field" : "Save"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Retire a field: it is no longer shown for new values, but every value stays readable. */
const RetireDialog = ({ field, onClose }) => {
  const mutation = useCustomFieldMutation();
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  return (
    <Dialog title={`Retire ${field.label}`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) mutation.mutate({ action: "retire", id: field.id, reason: reason.trim() }, { onSuccess: () => onClose() });
        }}>
        <p className="text-sm text-secondary-text">Records keep the values they hold, and you can bring the field back later. A retired field stops counting towards the limit of 20.</p>
        <TextAreaField label="Why is it retired?" required rows={2} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton onClick={onClose} type="neutral" size="md">
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="danger" size="md" disabled={!ok || mutation.isPending} loading={mutation.isPending}>
            Retire field
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * Settings → Data Management → Custom fields: the organisation's own fields for each kind of record (up to 20 in use each). Everyone sees the
 * fields on the records; only people with "Manage custom fields" change them here.
 */
const CustomFieldsSettings = () => {
  const { can } = usePermissions();
  const canManage = can("custom_fields.manage");
  const { showToast } = useToast();
  const [entityType, setEntityType] = useState("part");
  const [dialog, setDialog] = useState(null);
  const { data, isLoading, error } = useCustomFields(entityType, { includeRetired: true });
  const mutation = useCustomFieldMutation();

  if (isLoading && !data) return <LoadingScreen size="sm" />;
  if (error) return <p className="p-6 text-error-color">{describeApiError(error)}</p>;

  const all = data?.data ?? [];
  const active = all.filter((f) => f.active);
  const retired = all.filter((f) => !f.active);
  const entities = data?.entities ?? [];
  const stages = entities.find((e) => e.entityType === entityType)?.stages ?? [];
  const limit = data?.limit ?? 20;
  const full = active.length >= limit;
  const fail = (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) });

  const move = (index, by) => {
    const ids = active.map((f) => f.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved);
    mutation.mutate({ action: "reorder", entityType, ids: [...ids, ...retired.map((f) => f.id)] }, { onError: fail });
  };

  const count = (value) => entities.find((e) => e.entityType === value)?.activeCount ?? 0;

  return (
    <div className="flex w-full flex-col gap-4">
      <MenuCard
        title="Custom fields"
        subtitle="Your organisation's own fields, shown on each record under More details, in registers and offered by imports. Fortress offers no ready-made fields."
        action={
          canManage && (
            <CTAButton type="main" size="lg" disabled={full} onClick={() => setDialog({ kind: "field" })} title={full ? `This kind of record already has ${limit} fields in use` : undefined}>
              <span className="flex items-center gap-1">
                <PlusIcon /> Add field
              </span>
            </CTAButton>
          )
        }>
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_1fr] sm:items-end">
            <ComboField
              label="Kind of record"
              required
              value={entityType}
              onChange={(v) => v && setEntityType(v)}
              options={CUSTOM_FIELD_ENTITIES.map((e) => ({ value: e.value, label: e.label, hint: count(e.value) ? `${count(e.value)} in use` : undefined }))}
            />
            <p className="text-sm text-secondary-text" aria-live="polite">
              {active.length} of {limit} fields in use{retired.length ? `, ${retired.length} retired` : ""}.
            </p>
          </div>
          {full && canManage && <Callout tone="info">This kind of record has {limit} fields in use, the most allowed. Retire one to add another.</Callout>}
          {active.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-color p-6 text-center text-sm text-secondary-text">
              No custom fields on {entityLabel(entityType).toLowerCase()} yet.{canManage ? " Add one to record something Fortress does not ask for." : ""}
            </p>
          ) : (
            <ul aria-label={`Custom fields on ${entityLabel(entityType).toLowerCase()}`} className="flex flex-col divide-y divide-border-color rounded-lg border border-border-color">
              {active.map((f, i) => {
                const required = requiredLabel(f.requiredAt, stages);
                return (
                  <li key={f.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    {canManage && (
                      <div className="flex flex-col">
                        <button type="button" aria-label={`Move ${f.label} up`} disabled={i === 0 || mutation.isPending} className="cursor-pointer rounded p-0.5 text-secondary-text hover:text-primary-text disabled:cursor-default disabled:opacity-30" onClick={() => move(i, -1)}>
                          <ArrowUpIcon />
                        </button>
                        <button type="button" aria-label={`Move ${f.label} down`} disabled={i === active.length - 1 || mutation.isPending} className="cursor-pointer rounded p-0.5 text-secondary-text hover:text-primary-text disabled:cursor-default disabled:opacity-30" onClick={() => move(i, 1)}>
                          <ArrowDownIcon />
                        </button>
                      </div>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium text-primary-text">{f.label}</span>
                      <span className="text-xs text-secondary-text">
                        <span className="font-mono">{f.key}</span>
                        {f.section ? ` · ${f.section}` : ""}
                        {f.helpText ? ` · ${f.helpText}` : ""}
                      </span>
                    </div>
                    <span className="rounded-full bg-border-color/60 px-2 py-0.5 text-xs text-primary-text">{fieldTypeLabel(f.fieldType)}</span>
                    {isListType(f.fieldType) && <span className="text-xs text-secondary-text">{f.options.filter((o) => o.active).length} options</span>}
                    {required && <span className="rounded-full bg-warning-color/15 px-2 py-0.5 text-xs font-medium text-warning-color">{required}</span>}
                    {canManage && (
                      <RowActionsMenu
                        label={`Actions for ${f.label}`}
                        items={[
                          { label: "Edit", onSelect: () => setDialog({ kind: "field", field: f }) },
                          { separator: true },
                          { label: "Retire", tone: "danger", onSelect: () => setDialog({ kind: "retire", field: f }) },
                        ]}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {retired.length > 0 && (
            <details className="rounded-lg border border-border-color">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-secondary-text">Retired fields ({retired.length})</summary>
              <ul aria-label="Retired fields" className="flex flex-col divide-y divide-border-color border-t border-border-color">
                {retired.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm text-secondary-text">{f.label}</span>
                      <span className="text-xs text-secondary-text">
                        {fieldTypeLabel(f.fieldType)} · retired: {f.retireReason}
                      </span>
                    </div>
                    {canManage && (
                      <CTAButton
                        type="secondary"
                        size="md"
                        disabled={full || mutation.isPending}
                        loading={mutation.isPending && mutation.variables?.id === f.id}
                        onClick={() => mutation.mutate({ action: "reactivate", id: f.id }, { onError: fail })}>
                        Bring back
                      </CTAButton>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </MenuCard>
      {dialog?.kind === "field" && <FieldDialog entityType={entityType} stages={stages} existing={dialog.field} onClose={() => setDialog(null)} />}
      {dialog?.kind === "retire" && <RetireDialog field={dialog.field} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default CustomFieldsSettings;
