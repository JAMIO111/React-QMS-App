import { useState } from "react";
import { PlusIcon, Trash2Icon, XIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Field from "../ui/Field";
import SlidingToggle from "../ui/SlidingToggle";
import { TextAreaField } from "../master-data/shared";
import { MachinePicker, PartPicker, PartyPicker, RemoteComboBox } from "../ncr/Pickers";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { useCustomFieldPeople } from "../../hooks/useCustomFields";
import { useGaugeTypes } from "../../hooks/useCalibration";
import { usePartFamilies } from "../../hooks/useProcessControl";
import { useAllDepartments, useRoles, useSites } from "../../hooks/useQmsApi";
import { OP_LABELS, RECIPIENT_KINDS, canHoldLot, isListOp, needsValue, newAction, newCondition, opsFor } from "../../lib/workflows";

const box = "flex flex-col gap-3 rounded-xl border border-border-color bg-primary-bg p-3";

const FamilyPicker = ({ label, value, onChange }) => {
  const [q, setSearch] = useDebouncedSearch();
  const families = usePartFamilies({ q });
  return (
    <RemoteComboBox
      label={label}
      value={value}
      onChange={onChange}
      placeholder="Search a part family…"
      items={(families.data?.items ?? []).map((f) => ({ id: f.id, name: f.code ? `${f.code} · ${f.name}` : f.name }))}
      isFetching={families.isFetching}
      onSearch={setSearch}
    />
  );
};

/** One record picker for a field that names a record (site, part, supplier …). onChange(id, name). */
const RefPicker = ({ refKind, label, value, onChange, labels }) => {
  const sites = useSites();
  const gaugeTypes = useGaugeTypes({ enabled: refKind === "gauge_type" });
  const current = value ? { id: value, name: labels[value] ?? "…" } : undefined;
  const pick = (id, item) => onChange(id, item?.name ?? null);
  if (refKind === "site")
    return (
      <ComboField
        label={label}
        value={value}
        onChange={(id) => onChange(id, (sites.data?.data ?? []).find((s) => s.id === id)?.name ?? null)}
        options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.code }))}
        required
      />
    );
  if (refKind === "gauge_type")
    return (
      <ComboField
        label={label}
        value={value}
        onChange={(id) => onChange(id, (gaugeTypes.data ?? []).find((g) => g.id === id)?.name ?? null)}
        options={(gaugeTypes.data ?? []).map((g) => ({ value: g.id, label: g.name, hint: g.code }))}
        required
      />
    );
  if (refKind === "part") return <PartPicker label={label} value={value} onChange={pick} current={current && { id: value, partNumber: current.name }} />;
  if (refKind === "machine") return <MachinePicker label={label} value={value} onChange={pick} current={current} />;
  if (refKind === "supplier" || refKind === "customer")
    return <PartyPicker kind={`${refKind}s`} label={label} value={value} onChange={pick} current={current} />;
  if (refKind === "part_family") return <FamilyPicker label={label} value={value} onChange={pick} />;
  return null;
};

const Chips = ({ values, words, onRemove, disabled }) =>
  values.length ? (
    <ul className="flex flex-wrap gap-1.5" aria-label="Chosen values">
      {values.map((v) => (
        <li key={v} className="flex items-center gap-1 rounded-full border border-border-color bg-secondary-bg px-2.5 py-0.5 text-sm text-primary-text">
          {words(v)}
          {!disabled && (
            <button type="button" onClick={() => onRemove(v)} aria-label={`Remove ${words(v)}`} className="text-secondary-text hover:text-error-color">
              <XIcon aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  ) : null;

/** What a condition compares with: a choice, several choices, a record, several records, or words. */
const ValueInput = ({ field, condition, onChange, labels, onLabel, disabled }) => {
  const list = isListOp(condition.op);
  const values = Array.isArray(condition.value) ? condition.value : condition.value ? [condition.value] : [];
  const label = list ? `${field.label}: values` : `${field.label}: value`;
  if (field.options) {
    if (!list)
      return <ComboField label={label} value={values[0] ?? null} onChange={(v) => onChange(v ?? "")} options={field.options} required disabled={disabled} />;
    return (
      <fieldset className="flex flex-col gap-1" disabled={disabled}>
        <legend className="text-sm font-medium text-secondary-text" data-required>
          {label}
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((o) => {
            const on = values.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])}
                className={`min-h-9.5 rounded-full border px-3 text-sm ${on ? "border-brand-primary bg-brand-primary/15 text-primary-text" : "border-border-color text-secondary-text hover:border-border-dark-color"}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  }
  if (field.type === "ref") {
    if (disabled) return <p className="text-sm text-primary-text">{values.map((v) => labels[v] ?? "a record no longer listed").join(", ") || "—"}</p>;
    if (!list)
      return (
        <RefPicker
          refKind={field.ref}
          label={label}
          value={values[0] ?? null}
          labels={labels}
          onChange={(id, name) => {
            if (id && name) onLabel(id, name);
            onChange(id ?? "");
          }}
        />
      );
    return (
      <div className="flex flex-col gap-2">
        <Chips values={values} words={(v) => labels[v] ?? "…"} onRemove={(v) => onChange(values.filter((x) => x !== v))} />
        <RefPicker
          key={values.length}
          refKind={field.ref}
          label={`Add to ${field.label.toLowerCase()}`}
          value={null}
          labels={labels}
          onChange={(id, name) => {
            if (!id) return;
            if (name) onLabel(id, name);
            if (!values.includes(id)) onChange([...values, id]);
          }}
        />
      </div>
    );
  }
  return (
    <Field
      label={label}
      hint={list ? "Separate values with commas" : undefined}
      value={Array.isArray(condition.value) ? condition.value.join(", ") : condition.value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      required
      disabled={disabled}
      maxLength={list ? 2000 : 200}
    />
  );
};

const ConditionRow = ({ index, condition, trigger, onChange, onRemove, labels, onLabel, disabled }) => {
  const field = trigger.fields.find((f) => f.key === condition.field);
  return (
    <li className={box} aria-label={`Condition ${index + 1}`}>
      <div className="flex flex-wrap items-end gap-3">
        <ComboField
          className="min-w-48 flex-1"
          label="Test"
          value={condition.field || null}
          onChange={(key) => {
            const f = trigger.fields.find((x) => x.key === key);
            onChange({ field: key ?? "", op: f?.type === "ordered" ? "gte" : "eq", value: "" });
          }}
          options={trigger.fields.map((f) => ({ value: f.key, label: f.label }))}
          required
          disabled={disabled}
        />
        <ComboField
          className="min-w-40"
          label="How"
          value={condition.op}
          onChange={(op) => {
            if (!op) return;
            const was = isListOp(condition.op);
            const now = isListOp(op);
            const value = !needsValue(op) ? "" : was === now ? condition.value : now ? (condition.value ? [condition.value].flat() : []) : (Array.isArray(condition.value) ? condition.value[0] ?? "" : condition.value);
            onChange({ ...condition, op, value });
          }}
          options={opsFor(field).map((op) => ({ value: op, label: OP_LABELS[op] }))}
          required
          disabled={disabled || !field}
        />
        {!disabled && (
          <CTAButton type="neutral" onClick={onRemove} aria-label={`Remove condition ${index + 1}`} icon={Trash2Icon} />
        )}
      </div>
      {field && needsValue(condition.op) && (
        <ValueInput field={field} condition={condition} onChange={(value) => onChange({ ...condition, value })} labels={labels} onLabel={onLabel} disabled={disabled} />
      )}
    </li>
  );
};

/** Who: the record's owner, a person, everyone with a role, everyone in a department. */
const RecipientRow = ({ recipient, onChange, onRemove, allowGroups, labels, onLabel, disabled, label }) => {
  const people = useCustomFieldPeople();
  const roles = useRoles();
  const departments = useAllDepartments();
  const kinds = allowGroups ? RECIPIENT_KINDS : RECIPIENT_KINDS.filter((k) => k.value === "record_owner" || k.value === "person");
  const options = {
    person: (people.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    role: (roles.data?.data ?? []).map((r) => ({ value: r.id, label: r.name })),
    department: (departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name, hint: d.siteName ?? d.site?.name })),
  };
  const idKey = { person: "userId", role: "roleId", department: "departmentId" }[recipient.kind];
  return (
    <div className="flex flex-wrap items-end gap-3">
      <ComboField
        className="min-w-48"
        label={label}
        value={recipient.kind}
        onChange={(kind) => kind && onChange({ kind })}
        options={kinds}
        required
        disabled={disabled}
      />
      {idKey && (
        <ComboField
          className="min-w-56 flex-1"
          label={{ person: "Person", role: "Role", department: "Department" }[recipient.kind]}
          value={recipient[idKey] ?? null}
          onChange={(id) => {
            const name = options[recipient.kind].find((o) => o.value === id)?.label;
            if (id && name) onLabel(id, name);
            onChange({ kind: recipient.kind, [idKey]: id ?? undefined });
          }}
          options={options[recipient.kind].length || !recipient[idKey] ? options[recipient.kind] : [{ value: recipient[idKey], label: labels[recipient[idKey]] ?? "…" }]}
          required
          disabled={disabled}
        />
      )}
      {onRemove && !disabled && <CTAButton type="neutral" onClick={onRemove} aria-label={`Remove ${label.toLowerCase()}`} icon={XIcon} />}
    </div>
  );
};

/** "After N days, if the record still …, do these": the conditions are read again when the time comes. */
const LaterBody = ({ action, n, onChange, trigger, labels, onLabel, disabled }) => (
  <div className="flex flex-col gap-3">
    <Field
      className="w-40"
      label="After (days)"
      type="number"
      min={1}
      max={365}
      value={action.afterDays ?? ""}
      onChange={(e) => onChange({ ...action, afterDays: e.target.value === "" ? "" : Number(e.target.value) })}
      required
      disabled={disabled}
    />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm font-medium text-secondary-text">If the record then still meets{action.conditions.length ? "" : " (no conditions: always)"}</p>
      {action.conditions.length > 1 && (
        <SlidingToggle
          ariaLabel={`How action ${n}'s conditions combine`}
          options={[
            { value: "all", label: "All of these", disabled },
            { value: "any", label: "Any of these", disabled },
          ]}
          value={action.match}
          onChange={(match) => onChange({ ...action, match })}
        />
      )}
    </div>
    <ol className="flex flex-col gap-2" aria-label={`Action ${n}: still true`}>
      {action.conditions.map((c, i) => (
        <ConditionRow
          key={i}
          index={i}
          condition={c}
          trigger={trigger}
          labels={labels}
          onLabel={onLabel}
          disabled={disabled}
          onChange={(next) => onChange({ ...action, conditions: action.conditions.map((x, j) => (j === i ? next : x)) })}
          onRemove={() => onChange({ ...action, conditions: action.conditions.filter((_, j) => j !== i) })}
        />
      ))}
    </ol>
    {!disabled && action.conditions.length < 20 && (
      <CTAButton type="neutral" className="self-start" icon={PlusIcon} onClick={() => onChange({ ...action, conditions: [...action.conditions, newCondition(trigger)] })}>
        Add a condition
      </CTAButton>
    )}
    <p className="text-sm font-medium text-secondary-text">Then</p>
    <ol className="flex flex-col gap-2">
      {action.actions.map((inner, j) => (
        <ActionCard
          key={j}
          index={j}
          parent={n}
          action={inner}
          trigger={trigger}
          labels={labels}
          onLabel={onLabel}
          disabled={disabled}
          canRemove={action.actions.length > 1}
          onChange={(next) => onChange({ ...action, actions: action.actions.map((x, k) => (k === j ? next : x)) })}
          onRemove={() => onChange({ ...action, actions: action.actions.filter((_, k) => k !== j) })}
        />
      ))}
    </ol>
    {!disabled && action.actions.length < 5 && (
      <CTAButton type="neutral" className="self-start" icon={PlusIcon} onClick={() => onChange({ ...action, actions: [...action.actions, newAction("notify")] })}>
        Add something to do then
      </CTAButton>
    )}
  </div>
);

const ActionCard = ({ index, action, onChange, onRemove, labels, onLabel, disabled, canRemove, trigger, parent }) => {
  const n = parent ? `${parent}.${index + 1}` : `${index + 1}`;
  const types = [
    { value: "notify", label: "Tell people", disabled },
    { value: "task", label: "Give a task", disabled },
    canHoldLot(trigger) && { value: "hold_lot", label: "Hold the lot", disabled },
    !parent && trigger && { value: "later", label: "Later, if still…", disabled },
  ].filter(Boolean);
  return (
    <li className={box} aria-label={`Action ${n}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SlidingToggle ariaLabel={`What action ${n} does`} options={types} value={action.type} onChange={(type) => onChange(newAction(type))} />
        {canRemove && !disabled && <CTAButton type="neutral" onClick={onRemove} aria-label={`Remove action ${n}`} icon={Trash2Icon} text="Remove" />}
      </div>
      {action.type === "hold_lot" ? (
        <>
          <Field label="Why the lot is held" value={action.reason} onChange={(e) => onChange({ ...action, reason: e.target.value })} required maxLength={500} disabled={disabled}
            hint="The lot named on the record is put on hold, with the authority of whoever saves this version of the rule. If they may no longer hold lots there, nothing is held and they are told." />
        </>
      ) : action.type === "later" ? (
        <LaterBody action={action} n={n} onChange={onChange} trigger={trigger} labels={labels} onLabel={onLabel} disabled={disabled} />
      ) : action.type === "notify" ? (
        <>
          <div className="flex flex-col gap-2">
            {action.recipients.map((r, i) => (
              <RecipientRow
                key={i}
                label={`Who is told${action.recipients.length > 1 ? ` (${i + 1})` : ""}`}
                recipient={r}
                allowGroups
                labels={labels}
                onLabel={onLabel}
                disabled={disabled}
                onChange={(next) => onChange({ ...action, recipients: action.recipients.map((x, j) => (j === i ? next : x)) })}
                onRemove={action.recipients.length > 1 ? () => onChange({ ...action, recipients: action.recipients.filter((_, j) => j !== i) }) : null}
              />
            ))}
            {!disabled && action.recipients.length < 20 && (
              <CTAButton type="neutral" className="self-start" icon={PlusIcon} onClick={() => onChange({ ...action, recipients: [...action.recipients, { kind: "person" }] })}>
                Tell someone else too
              </CTAButton>
            )}
          </div>
          <TextAreaField label="Message" value={action.message} onChange={(e) => onChange({ ...action, message: e.target.value })} required maxLength={500} rows={2} disabled={disabled}
            hint="Sent with the rule's name and the record it is about. Only people who may read the record are told." />
        </>
      ) : (
        <>
          <RecipientRow label="Who gets the task" recipient={action.assignee} labels={labels} onLabel={onLabel} disabled={disabled} onChange={(assignee) => onChange({ ...action, assignee })} />
          <div className="flex flex-wrap gap-3">
            <Field className="min-w-64 flex-1" label="Task" value={action.title} onChange={(e) => onChange({ ...action, title: e.target.value })} required maxLength={200} disabled={disabled} />
            <Field
              className="w-36"
              label="Due in (days)"
              type="number"
              min={0}
              max={365}
              value={action.dueDays ?? ""}
              onChange={(e) => onChange({ ...action, dueDays: e.target.value === "" ? "" : Number(e.target.value) })}
              disabled={disabled}
            />
          </div>
          <TextAreaField label="More detail (optional)" value={action.detail ?? ""} onChange={(e) => onChange({ ...action, detail: e.target.value })} maxLength={2000} rows={2} disabled={disabled} />
        </>
      )}
    </li>
  );
};

/**
 * The rule as forms (no code): what starts it, what it tests (all or any), and what it does. `draft` is the editable shape from lib/workflows.js; `labels` names ids
 * (records, people, roles) and `onLabel` adds a name when something is picked.
 */
const RuleBuilder = ({ draft, setDraft, triggers, labels, onLabel, disabled }) => {
  const trigger = triggers.find((t) => t.eventType === draft.trigger);
  const [confirmTrigger, setConfirmTrigger] = useState(null);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  // Conditions test the old record, so a new trigger clears them (the rule's and its timers').
  const withTrigger = (eventType) => ({
    trigger: eventType,
    conditions: [],
    actions: draft.actions.map((a) => (a.type === "later" ? { ...a, conditions: [] } : a)),
  });
  const hasConditions = draft.conditions.length > 0 || draft.actions.some((a) => a.type === "later" && a.conditions.length > 0);
  const changeTrigger = (eventType) => {
    if (!eventType || eventType === draft.trigger) return;
    if (hasConditions && draft.trigger) setConfirmTrigger(eventType);
    else set(withTrigger(eventType));
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-3">
        <Field className="min-w-64 flex-1" label="Name" value={draft.name} onChange={(e) => set({ name: e.target.value })} required maxLength={120} disabled={disabled} />
      </div>
      <TextAreaField label="Description (optional)" value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} rows={2} disabled={disabled} />

      <section aria-labelledby="wf-when" className="flex flex-col gap-2">
        <h3 id="wf-when" className="text-base font-semibold text-primary-text">
          When
        </h3>
        <ComboField
          label="What starts the rule"
          value={draft.trigger || null}
          onChange={changeTrigger}
          options={triggers.map((t) => ({ value: t.eventType, label: t.label }))}
          required
          disabled={disabled}
        />
        {confirmTrigger && (
          <Callout
            tone="warning"
            role="alert"
            action={
              <span className="flex gap-2">
                <CTAButton type="secondary" onClick={() => { set(withTrigger(confirmTrigger)); setConfirmTrigger(null); }}>
                  Change it
                </CTAButton>
                <CTAButton type="neutral" onClick={() => setConfirmTrigger(null)}>
                  Keep it
                </CTAButton>
              </span>
            }
          >
            Changing what starts the rule removes its conditions, which test the old record.
          </Callout>
        )}
      </section>

      {trigger && (
        <section aria-labelledby="wf-if" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="wf-if" className="text-base font-semibold text-primary-text">
              If
            </h3>
            {draft.conditions.length > 1 && (
              <SlidingToggle
                ariaLabel="How the conditions combine"
                options={[
                  { value: "all", label: "All of these", disabled },
                  { value: "any", label: "Any of these", disabled },
                ]}
                value={draft.match}
                onChange={(match) => set({ match })}
              />
            )}
          </div>
          {draft.conditions.length === 0 && <p className="text-sm text-secondary-text">No conditions: the rule runs every time.</p>}
          <ol className="flex flex-col gap-2">
            {draft.conditions.map((c, i) => (
              <ConditionRow
                key={i}
                index={i}
                condition={c}
                trigger={trigger}
                labels={labels}
                onLabel={onLabel}
                disabled={disabled}
                onChange={(next) => set({ conditions: draft.conditions.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })}
              />
            ))}
          </ol>
          {!disabled && draft.conditions.length < 20 && (
            <CTAButton type="neutral" className="self-start" icon={PlusIcon} onClick={() => set({ conditions: [...draft.conditions, newCondition(trigger)] })}>
              Add a condition
            </CTAButton>
          )}
        </section>
      )}

      <section aria-labelledby="wf-then" className="flex flex-col gap-2">
        <h3 id="wf-then" className="text-base font-semibold text-primary-text" data-required>
          Then
        </h3>
        <ol className="flex flex-col gap-2">
          {draft.actions.map((a, i) => (
            <ActionCard
              key={i}
              index={i}
              action={a}
              labels={labels}
              onLabel={onLabel}
              disabled={disabled}
              canRemove={draft.actions.length > 1}
              trigger={trigger}
              onChange={(next) => set({ actions: draft.actions.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => set({ actions: draft.actions.filter((_, j) => j !== i) })}
            />
          ))}
        </ol>
        {!disabled && draft.actions.length < 10 && (
          <CTAButton type="neutral" className="self-start" icon={PlusIcon} onClick={() => set({ actions: [...draft.actions, newAction("notify")] })}>
            Add an action
          </CTAButton>
        )}
      </section>
    </div>
  );
};

export default RuleBuilder;
