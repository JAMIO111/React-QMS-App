import { useState } from "react";
import { PencilIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useCustomerRules, useRequirements, useSaveRequirements, useSetCustomerRules } from "../../hooks/usePpap";
import { CELL, CELL_OPTIONS, ELEMENTS, LEVELS, MINIMUMS, formatDay, levelLabel, levelSummary, matrixRows } from "../../lib/ppap";
import { ErrorNotice, FormError } from "../master-data/shared";
import { PartyPicker } from "../ncr/Pickers";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";

const LEVEL_CHOICES = LEVELS.map((l) => ({ value: String(l), label: levelLabel(l) }));

/** Which elements each level sends, keeps or leaves out. */
const Matrix = ({ rows }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-left text-sm" aria-label="Elements by level">
      <thead>
        <tr className="text-xs uppercase tracking-wide text-secondary-text">
          <th scope="col" className="py-1 pr-3">Element</th>
          {LEVELS.map((l) => (
            <th key={l} scope="col" className="px-2 py-1">{levelLabel(l)}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-border-color">
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row" className="py-1.5 pr-3 font-medium text-primary-text">{r.label}</th>
            {r.levels.map((c, i) => (
              <td key={i} className={`px-2 py-1.5 ${c === "submit" ? "text-primary-text" : "text-secondary-text"}`}>{CELL[c]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** Change the requirement set: the matrix and the minimums. Saved as a new version with a reason; submissions already started keep the version they started with. */
const RequirementsDialog = ({ current, onClose }) => {
  const save = useSaveRequirements();
  const { showToast } = useToast();
  const [config, setConfig] = useState(() => JSON.parse(JSON.stringify(current.config)));
  const [reason, setReason] = useState("");
  const changed = JSON.stringify(config) !== JSON.stringify(current.config);
  const setCell = (key, level, value) => setConfig((c) => ({ ...c, rows: { ...c.rows, [key]: { ...c.rows[key], [String(level)]: value } } }));
  const setMin = (key, value) => setConfig((c) => ({ ...c, [key]: value === "" ? "" : Number(value) }));
  const minsOk = MINIMUMS.every((m) => config[m.key] !== "" && Number(config[m.key]) > 0);
  const ready = changed && minsOk && reason.trim().length >= 3;

  const submit = (e) => {
    e.preventDefault();
    if (!ready) return;
    save.mutate({ config, reason: reason.trim() }, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  };

  return (
    <Dialog title="Change the requirements" onClose={onClose} width="max-w-4xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <p className="text-sm text-secondary-text">It is saved as version {current.version + 1}. Submissions already started keep the version they started with.</p>
        <section className="flex flex-col gap-2" aria-label="Elements by level">
          <h3 className="text-base font-semibold text-primary-text">Elements by level</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-secondary-text">
                  <th scope="col" className="py-1 pr-3">Element</th>
                  {LEVELS.map((l) => (
                    <th key={l} scope="col" className="px-1 py-1">{levelLabel(l)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ELEMENTS.map((e) => (
                  <tr key={e.key}>
                    <th scope="row" className="py-1 pr-3 font-medium text-primary-text">{e.label}</th>
                    {LEVELS.map((l) => (
                      <td key={l} className="px-1 py-1">
                        <ComboField ariaLabel={`${e.label}, ${levelLabel(l)}`} value={config.rows[e.key]?.[String(l)] ?? "none"} onChange={(v) => v && setCell(e.key, l, v)} options={CELL_OPTIONS} clearable={false} sort={false} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="flex flex-col gap-3" aria-label="Defaults and minimums">
          <h3 className="text-base font-semibold text-primary-text">Defaults and minimums</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <ComboField label="Level when the customer has none" value={String(config.defaultLevel)} onChange={(v) => v && setConfig((c) => ({ ...c, defaultLevel: Number(v) }))} options={LEVEL_CHOICES} clearable={false} sort={false} />
            {MINIMUMS.map((m) => (
              <Field key={m.key} label={m.label} type="number" step={m.step} min="0" required value={String(config[m.key])} onChange={(e) => setMin(m.key, e.target.value)} />
            ))}
          </div>
        </section>
        <Field label="Why are the requirements changing?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} />
        <FormError error={save.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready || save.isPending} loading={save.isPending}>
            Save as version {current.version + 1}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const numberOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

/** One customer's own rules: their usual level, extra elements and own minimums. Empty means "follow the organisation". */
const CustomerRulesDialog = ({ rules, onClose }) => {
  const save = useSetCustomerRules();
  const { showToast } = useToast();
  const [customer, setCustomer] = useState(rules ? { id: rules.customerId, name: rules.customerName ?? "" } : null);
  const [form, setForm] = useState(() => ({
    defaultLevel: rules?.defaultLevel ? String(rules.defaultLevel) : "",
    extraElements: rules?.extraElements ?? [],
    minCpkInitial: rules?.minCpkInitial ?? "",
    minCpkOngoing: rules?.minCpkOngoing ?? "",
    minReadings: rules?.minReadings ?? "",
    maxGrrPercent: rules?.maxGrrPercent ?? "",
    note: rules?.note ?? "",
  }));
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (key) => setForm((f) => ({ ...f, extraElements: f.extraElements.includes(key) ? f.extraElements.filter((x) => x !== key) : [...f.extraElements, key] }));

  const submit = (e) => {
    e.preventDefault();
    if (!customer?.id) return;
    save.mutate(
      {
        customerId: customer.id,
        body: {
          defaultLevel: form.defaultLevel ? Number(form.defaultLevel) : null,
          extraElements: form.extraElements,
          minCpkInitial: numberOrNull(form.minCpkInitial),
          minCpkOngoing: numberOrNull(form.minCpkOngoing),
          minReadings: numberOrNull(form.minReadings),
          maxGrrPercent: numberOrNull(form.maxGrrPercent),
          note: form.note.trim() || null,
        },
      },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) },
    );
  };

  return (
    <Dialog title={rules ? `Rules for ${rules.customerName}` : "Add a customer's rules"} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {rules ? (
          <p className="text-sm text-primary-text">{rules.customerName}</p>
        ) : (
          <PartyPicker label="Customer" kind="customers" required value={customer?.id ?? null} current={customer?.id ? { id: customer.id, name: customer.name ?? "" } : undefined} onChange={(id, item) => setCustomer(id ? { id, name: item?.name ?? "" } : null)} />
        )}
        <ComboField label="Their usual level" value={form.defaultLevel} onChange={(v) => set("defaultLevel", v ?? "")} options={[{ value: "", label: "Follow the organisation" }, ...LEVEL_CHOICES]} clearable={false} sort={false} />
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-primary-text">Elements they always want, whatever the level</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {ELEMENTS.filter((e) => e.key !== "part_submission_warrant").map((e) => (
              <label key={e.key} className="flex items-center gap-2 text-sm text-primary-text">
                <input type="checkbox" checked={form.extraElements.includes(e.key)} onChange={() => toggle(e.key)} />
                {e.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          {MINIMUMS.map((m) => (
            <Field key={m.key} label={m.label} type="number" step={m.step} min="0" hint="Empty follows the organisation" value={String(form[m.key])} onChange={(e) => set(m.key, e.target.value)} />
          ))}
        </div>
        <Field label="Note" value={form.note} onChange={(e) => set("note", e.target.value)} maxLength={1000} />
        <FormError error={save.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!customer?.id || save.isPending} loading={save.isPending}>
            Save
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Settings → Data Management → PPAP: which elements each level needs, the study minimums and each customer's own rules. */
const SettingsPpap = () => {
  const requirements = useRequirements();
  const rules = useCustomerRules();
  const [changing, setChanging] = useState(false);
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new, object = that customer
  if (requirements.isLoading || rules.isLoading) return <LoadingScreen />;
  if (requirements.error) return <ErrorNotice error={requirements.error} />;
  const r = requirements.data;
  const canChange = r.canChange;
  const cur = r.current;

  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Requirements"
        subtitle={cur ? `Version ${cur.version}. Which of the 18 elements a submission needs at each level, and the study minimums.` : "No requirements are set yet."}
        action={
          canChange &&
          cur && (
            <CTAButton type="main" icon={PencilIcon} onClick={() => setChanging(true)}>
              Change the requirements
            </CTAButton>
          )
        }>
        {cur ? (
          <div className="flex flex-col gap-4">
            <Callout tone="info" title="Your own wording of what each level needs">
              These start as a neutral reading of the usual five levels. Change them to match the customer manuals you work to; Fortress does not reproduce those documents.
            </Callout>
            <ul className="flex flex-wrap gap-2 text-sm text-secondary-text" aria-label="Elements sent per level">
              {levelSummary(cur.config).map((s) => (
                <li key={s.level} className="rounded-full bg-secondary-bg px-2 py-0.5">{levelLabel(s.level)}: {s.send} sent</li>
              ))}
            </ul>
            <Matrix rows={matrixRows(cur.config)} />
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {MINIMUMS.map((m) => (
                <div key={m.key}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{m.label}</dt>
                  <dd className="text-primary-text">{cur.config[m.key]}</dd>
                </div>
              ))}
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Level when the customer has none</dt>
                <dd className="text-primary-text">{levelLabel(cur.config.defaultLevel)}</dd>
              </div>
            </dl>
            {r.versions.length > 1 && (
              <details>
                <summary className="cursor-pointer text-sm text-secondary-text">Versions ({r.versions.length})</summary>
                <ul className="mt-2 flex flex-col gap-1 text-sm" aria-label="Requirement versions">
                  {r.versions.map((v) => (
                    <li key={v.id} className="text-primary-text">
                      Version {v.version}
                      {v.current ? " (current)" : ""} <span className="text-secondary-text">· {formatDay(v.at.slice(0, 10))}{v.by?.name ? ` · ${v.by.name}` : ""}{v.reason ? ` · ${v.reason}` : ""}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : null}
      </MenuCard>

      <MenuCard
        title="Customer rules"
        subtitle="Some customers ask for a different level, extra elements or tighter minimums. A rule here is applied when a submission is started for them."
        action={
          rules.data?.canChange && (
            <CTAButton type="secondary" onClick={() => setEditing(null)}>
              Add a customer
            </CTAButton>
          )
        }>
        {rules.error ? (
          <ErrorNotice error={rules.error} />
        ) : (rules.data?.data ?? []).length === 0 ? (
          <p className="text-sm text-secondary-text">No customer has rules of their own. Submissions follow the requirements above.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color" aria-label="Customer rules">
            {rules.data.data.map((c) => (
              <li key={c.customerId} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-40 flex-1 font-medium text-primary-text">{c.customerName ?? "Customer"}</span>
                <span className="text-sm text-secondary-text">
                  {c.defaultLevel ? levelLabel(c.defaultLevel) : "Follows the organisation"}
                  {c.extraElements.length > 0 ? ` · ${c.extraElements.length} extra ${c.extraElements.length === 1 ? "element" : "elements"}` : ""}
                </span>
                {rules.data.canChange && (
                  <CTAButton type="neutral" size="md" onClick={() => setEditing(c)}>
                    Edit
                  </CTAButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </MenuCard>

      {changing && cur && <RequirementsDialog current={cur} onClose={() => setChanging(false)} />}
      {editing !== undefined && <CustomerRulesDialog rules={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
};

export default SettingsPpap;
