import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PartPicker } from "../ncr/Pickers";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import MenuCard from "../ui/MenuCard";
import { useAllDepartments, useMembers, usePermissions, useRoles } from "../../hooks/useQmsApi";
import { useMachines, usePartFamilies } from "../../hooks/useProcessControl";
import { useAlertMutation, useQualityAlert } from "../../hooks/useDocumentation";
import AlertFiles from "./AlertFiles";
import { LinksEditor } from "./AlertLinks";
import { CATEGORIES, SEVERITIES, linkBody, referenceText } from "../../lib/qualityAlerts";
import { ErrorNotice, FormError, SelectField, TextAreaField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";
import { ArrowUpIcon, ChevronDownIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import Callout from "../ui/Callout";

const empty = {
  title: "", category: "product", severity: "medium", description: "", actions: [], effectiveDate: "", expiryDate: "", acknowledgeBy: "",
  parts: [], machines: [], operations: [], links: [], departments: [], targetDepartments: [], targetRoles: [], targetPeople: [],
};

const fromAlert = (a) => ({
  title: a.title, category: a.category, severity: a.severity, description: a.description ?? "",
  actions: a.actions.map((x) => ({ key: x.id, description: x.description, departmentId: x.departmentId, machineId: x.machineId })),
  effectiveDate: a.effectiveDate ?? "", expiryDate: a.expiryDate ?? "", acknowledgeBy: a.acknowledgeBy ?? "",
  parts: a.scope.parts.map((p) => ({ key: p.id, partId: p.partId, partFamilyId: p.partFamilyId, label: p.label })),
  machines: a.scope.machines.map((m) => ({ id: m.machineId, label: m.label })),
  operations: a.scope.operations,
  links: a.links.map((l) => ({ kind: l.kind, recordId: l.recordId, label: l.label, source: l.source, gaugeId: l.gaugeId })),
  departments: a.scope.departments.map((d) => d.departmentId), targetDepartments: a.scope.targets.filter((t) => t.kind === "department").map((t) => t.departmentId),
  targetRoles: a.scope.targets.filter((t) => t.kind === "role").map((t) => t.roleId),
  targetPeople: a.scope.targets.filter((t) => t.kind === "person").map((t) => t.membershipId),
});

const Chips = ({ items, onRemove, label }) => (
  <ul className="flex flex-wrap gap-1.5" aria-label={label}>
    {items.map((x) => (
      <li key={x.key} className="flex items-center gap-1 rounded-full border border-border-color px-2 py-0.5 text-sm text-primary-text">
        {x.label}
        <button type="button" aria-label={`Remove ${x.label}`} className="text-secondary-text hover:text-error-color cursor-pointer" onClick={() => onRemove(x.key)}>
          ×
        </button>
      </li>
    ))}
  </ul>
);

let nextKey = 0;
const blankAction = () => ({ key: `new-${nextKey++}`, description: "", departmentId: null, machineId: null });

/**
 * The actions people must take, one line each, in order. Each can be for a department and/or a machine, so one alert can say "Goods-in: quarantine
 * lot 77" and "Lathe 1: re-check the first piece". Empty lines are dropped when the draft is saved.
 */
const ActionsEditor = ({ actions, onChange, departments, machines }) => {
  const update = (key, patch) => onChange(actions.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const move = (index, by) => {
    const next = [...actions];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {actions.length === 0 && <p className="text-sm text-secondary-text">No actions yet. Add the first thing people must do.</p>}
      <ol className="flex flex-col gap-3" aria-label="Actions">
        {actions.map((x, i) => (
          <li key={x.key} className="flex flex-col gap-2 rounded-lg border border-border-color p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-primary-text">Action {i + 1}</span>
              <div className="flex items-center gap-1">
                <button type="button" aria-label={`Move action ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-secondary-text hover:text-brand-primary disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed">
                  <ArrowUpIcon size={16} />
                </button>
                <button type="button" aria-label={`Move action ${i + 1} down`} disabled={i === actions.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-secondary-text hover:text-brand-primary disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed">
                  <ChevronDownIcon size={16} />
                </button>
                <button type="button" aria-label={`Remove action ${i + 1}`} onClick={() => onChange(actions.filter((a) => a.key !== x.key))} className="rounded p-1 text-secondary-text hover:text-error-color cursor-pointer">
                  <Trash2Icon size={16} />
                </button>
              </div>
            </div>
            <TextAreaField label={`What must be done (action ${i + 1})`} required value={x.description} onChange={(e) => update(x.key, { description: e.target.value })} rows={2} maxLength={2000} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <RHFComboBox label="For department" placeholder="Anyone" clearable value={x.departmentId} onChange={(v) => update(x.key, { departmentId: v || null })} options={departments} hint="Optional" />
              <RHFComboBox label="On machine" placeholder="Any machine" clearable value={x.machineId} onChange={(v) => update(x.key, { machineId: v || null })} options={machines} hint="Optional" />
            </div>
          </li>
        ))}
      </ol>
      <div>
        <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} iconSize="h-4 w-4" onClick={() => onChange([...actions, blankAction()])}>Add action</CTAButton>
      </div>
    </div>
  );
};

const Checks = ({ legend, options, selected, onToggle }) => (
  <fieldset className="flex flex-col gap-1">
    <legend className="text-sm font-medium text-secondary-text">{legend}</legend>
    {options.length === 0 ? (
      <p className="text-sm text-secondary-text">None available.</p>
    ) : (
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <li key={o.id}>
            <label className="flex items-center gap-1 text-sm text-primary-text">
              <input type="checkbox" checked={selected.includes(o.id)} onChange={() => onToggle(o.id)} /> {o.label}
            </label>
          </li>
        ))}
      </ul>
    )}
  </fieldset>
);

/** Create or edit a draft quality alert: the content, what it affects and who must acknowledge it. */
const QualityAlertForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const existing = useQualityAlert(id);
  const mutation = useAlertMutation();
  const [form, setForm] = useState(empty);
  const [loaded, setLoaded] = useState(!id);
  const [problem, setProblem] = useState(null);
  const [operation, setOperation] = useState("");
  const [partAdded, setPartAdded] = useState(null);

  const departments = useAllDepartments();
  const machines = useMachines();
  const families = usePartFamilies();
  const roles = useRoles();
  const members = useMembers({ enabled: can("members.read") });

  useEffect(() => {
    if (id && existing.data && !loaded) {
      setForm(fromAlert(existing.data));
      setLoaded(true);
    }
  }, [id, existing.data, loaded]);

  if (id && existing.isLoading) return <p className="p-4 text-secondary-text">Loading…</p>;
  if (id && existing.error) return <div className="p-4"><ErrorNotice error={existing.error} /></div>;
  if (id && existing.data && existing.data.status !== "draft") {
    return <p className="p-4 text-primary-text">{referenceText(existing.data)} is issued and cannot be edited. Issue a revision from the alert page instead.</p>;
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setValue = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (k) => (value) => setForm((f) => ({ ...f, [k]: f[k].includes(value) ? f[k].filter((x) => x !== value) : [...f[k], value] }));
  const deptOptions = (departments.data?.data ?? []).map((d) => ({ id: d.id, label: `${d.code} · ${d.name}` }));
  const roleOptions = (roles.data?.data ?? []).map((r) => ({ id: r.id, label: r.name }));
  const people = (members.data?.data ?? []).filter((m) => m.status !== "removed").map((m) => ({ id: m.membershipId, label: [m.firstName, m.surname].filter(Boolean).join(" ") || m.email }));
  const actionDepartments = (departments.data?.data ?? []).map((d) => ({ id: d.id, name: d.name, hint: d.code }));
  const actionMachines = (machines.data?.items ?? []).map((m) => ({ id: m.id, name: m.name, hint: m.code }));
  const machineOptions = (machines.data?.items ?? []).filter((m) => !form.machines.some((x) => x.id === m.id)).map((m) => ({ id: m.id, name: m.name, hint: m.code }));
  const familyOptions = (families.data?.items ?? []).filter((f) => !form.parts.some((p) => p.partFamilyId === f.id)).map((f) => ({ id: f.id, name: f.name, hint: f.code }));

  const addPart = (partId, item) => {
    if (partId && !form.parts.some((p) => p.partId === partId)) setForm((f) => ({ ...f, parts: [...f.parts, { key: partId, partId, partFamilyId: null, label: item?.name ?? "Part" }] }));
    setPartAdded(null);
  };
  const addOperation = () => {
    const code = operation.trim();
    if (code && !form.operations.includes(code)) setForm((f) => ({ ...f, operations: [...f.operations, code] }));
    setOperation("");
  };

  const submit = (e) => {
    e.preventDefault();
    if (!form.title.trim()) return setProblem("Give the alert a title.");
    if (form.expiryDate && form.effectiveDate && form.expiryDate < form.effectiveDate) return setProblem("The expiry date cannot be before the effective date.");
    setProblem(null);
    const nullable = (v) => (v.trim() ? v.trim() : null);
    const body = {
      title: form.title.trim(),
      category: form.category,
      severity: form.severity,
      description: nullable(form.description),
      actions: form.actions.filter((x) => x.description.trim()).map((x) => ({ description: x.description.trim(), departmentId: x.departmentId || null, machineId: x.machineId || null })),
      effectiveDate: form.effectiveDate || null,
      expiryDate: form.expiryDate || null,
      acknowledgeBy: form.acknowledgeBy || null,
      scope: {
        parts: form.parts.map((p) => (p.partId ? { partId: p.partId } : { partFamilyId: p.partFamilyId })),
        machines: form.machines.map((m) => m.id),
        operations: form.operations,
        links: form.links.map(linkBody),
        departments: form.departments,
        targets: [
          ...form.targetDepartments.map((departmentId) => ({ departmentId })),
          ...form.targetRoles.map((roleId) => ({ roleId })),
          ...form.targetPeople.map((membershipId) => ({ membershipId })),
        ],
      },
    };
    mutation.mutate(id ? { action: "update", id, body } : { action: "create", body }, { onSuccess: (a) => navigate(`/Documentation/Quality-Alerts/${a.id}`) });
  };

  return (
    <form className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4" onSubmit={submit} noValidate aria-label="Quality alert">
      <div>
        <h1 className="text-2xl font-semibold text-primary-text">{id ? `Edit ${referenceText(existing.data)}` : "New quality alert"}</h1>
        <p className="text-sm text-secondary-text">A draft can be changed freely. Once issued it is frozen; corrections are issued as revisions.</p>
      </div>

      <MenuCard title="The alert" bodyClassName="flex flex-col gap-3">
        <Field label="Title" value={form.title} onChange={set("title")} required maxLength={200} hint="What is wrong, in one line. e.g. Incorrect material specification on bar stock lot 77" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField label="Category" required value={form.category} onChange={(v) => setValue("category")(v ?? "product")} options={CATEGORIES} />
          <SelectField label="Severity" required value={form.severity} onChange={(v) => setValue("severity")(v ?? "medium")} options={SEVERITIES} hint="High and critical alerts need an acknowledge-by date to be issued" />
        </div>
        <TextAreaField label="Description" required value={form.description} onChange={set("description")} rows={5} maxLength={10000} hint="The details of the issue" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <RHFDatePickerPopout label="Effective date" required valueFormat="iso" clearable value={form.effectiveDate} onChange={(v) => setValue("effectiveDate")(v ?? "")} hint="When it applies" placeholder="Select a date" />
          <RHFDatePickerPopout label="Expiry date" valueFormat="iso" clearable value={form.expiryDate} onChange={(v) => setValue("expiryDate")(v ?? "")} hint="Optional" placeholder="Select a date" />
          <RHFDatePickerPopout label="Acknowledge by" required={form.severity === "high" || form.severity === "critical"} valueFormat="iso" clearable value={form.acknowledgeBy} onChange={(v) => setValue("acknowledgeBy")(v ?? "")} hint="When people must have confirmed" placeholder="Select a date" />
        </div>
      </MenuCard>

      <MenuCard title={<span data-required>Required actions</span>} subtitle="What people must do. Add one line per action, each for a department, a machine, or everyone." bodyClassName="flex flex-col gap-3">
        <ActionsEditor actions={form.actions} onChange={setValue("actions")} departments={actionDepartments} machines={actionMachines} />
      </MenuCard>

      <MenuCard title="What it affects" subtitle="Optional, but it is how the alert is found where people work" bodyClassName="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-secondary-text">Products</h2>
          <Chips label="Products" items={form.parts.map((p) => ({ key: p.key, label: `${p.label}${p.partFamilyId ? " (family)" : ""}` }))} onRemove={(k) => setForm((f) => ({ ...f, parts: f.parts.filter((p) => p.key !== k) }))} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PartPicker label="Add a part" value={partAdded} onChange={addPart} />
            <RHFComboBox
              label="Add a part family"
              placeholder="Search part families…"
              value={null}
              onChange={(v) => {
                const o = familyOptions.find((x) => x.id === v);
                if (v) setForm((f) => ({ ...f, parts: [...f.parts, { key: v, partId: null, partFamilyId: v, label: o ? `${o.hint} · ${o.name}` : "Family" }] }));
              }}
              options={familyOptions}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-secondary-text">Machines</h2>
          <Chips label="Machines" items={form.machines.map((m) => ({ key: m.id, label: m.label }))} onRemove={(k) => setForm((f) => ({ ...f, machines: f.machines.filter((m) => m.id !== k) }))} />
          <RHFComboBox
            label="Add a machine"
            placeholder="Search machines…"
            value={null}
            onChange={(v) => {
              const o = machineOptions.find((x) => x.id === v);
              if (v) setForm((f) => ({ ...f, machines: [...f.machines, { id: v, label: o ? `${o.hint} · ${o.name}` : "Machine" }] }));
            }}
            options={machineOptions}
            className="sm:w-1/2"
          />
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-secondary-text">Operations</h2>
          <Chips label="Operations" items={form.operations.map((o) => ({ key: o, label: o }))} onRemove={(k) => setForm((f) => ({ ...f, operations: f.operations.filter((o) => o !== k) }))} />
          <div className="flex items-end gap-2">
            <Field label="Add an operation code" value={operation} onChange={(e) => setOperation(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addOperation())} maxLength={40} placeholder="e.g. OP-020" className="sm:w-1/2" />
            <CTAButton buttonType="button" type="neutral" size="md" onClick={addOperation} disabled={!operation.trim()}>Add</CTAButton>
          </div>
        </div>
        <Checks legend="Departments affected" options={deptOptions} selected={form.departments} onToggle={toggle("departments")} />
      </MenuCard>

      <MenuCard title="Related records" subtitle="Optional: the nonconformance, supplier, gauge or calibration this alert is about" bodyClassName="flex flex-col gap-3">
        <LinksEditor
          links={form.links}
          onAdd={(l) => setForm((f) => ({ ...f, links: [...f.links, l] }))}
          onRemove={(l) => setForm((f) => ({ ...f, links: f.links.filter((x) => !(x.kind === l.kind && x.recordId === l.recordId)) }))}
        />
      </MenuCard>

      {id ? (
        <MenuCard title="Files" bodyClassName="flex flex-col gap-3">
          <AlertFiles alertId={id} canEdit />
        </MenuCard>
      ) : (
        <p className="text-sm text-secondary-text">Files can be attached once the draft is saved.</p>
      )}

      <MenuCard title={<span data-required>Who must acknowledge</span>} subtitle="Choose departments, roles or named people. At least one is needed to issue." bodyClassName="flex flex-col gap-3">
        <Checks legend="Departments (their members)" options={deptOptions} selected={form.targetDepartments} onToggle={toggle("targetDepartments")} />
        {roleOptions.length > 0 && <Checks legend="Roles (everyone holding the role)" options={roleOptions} selected={form.targetRoles} onToggle={toggle("targetRoles")} />}
        {people.length > 0 && <Checks legend="Named people" options={people} selected={form.targetPeople} onToggle={toggle("targetPeople")} />}
      </MenuCard>

      {problem && <Callout tone="error" role="alert">{problem}</Callout>}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={() => navigate(id ? `/Documentation/Quality-Alerts/${id}` : "/Documentation/Quality-Alerts")}>Cancel</CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save draft"}</CTAButton>
      </div>
    </form>
  );
};

export default QualityAlertForm;
