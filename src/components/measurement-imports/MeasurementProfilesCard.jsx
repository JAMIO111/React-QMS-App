import { useMemo, useRef, useState } from "react";
import CTAButton from "@/components/CTAButton";
import { PlusIcon, UploadIcon } from "@/components/icons";
import { useGauges } from "../../hooks/useCalibration";
import { useMeasurementProfiles, useProfileMutation, useProfileTemplates, useTryProfile } from "../../hooks/useMeasurementImports";
import { describeApiError } from "../../lib/api-client";
import {
  COLUMN_FIELDS,
  DELIMITERS,
  ENCODINGS,
  fileToBase64,
  formToSettings,
  HEADER_LABELS,
  limitsWords,
  settingsProblems,
  settingsToForm,
} from "../../lib/measurementImports";
import { TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import RowActionsMenu from "../ui/RowActionsMenu";

const MAX_TRY = 2_097_152;

/** Read a file with the settings on screen and show what was found. Nothing is saved. */
const TryFile = ({ settings, disabled }) => {
  const tryFile = useTryProfile();
  const input = useRef(null);
  const [name, setName] = useState(null);
  const [problem, setProblem] = useState(null);
  const result = tryFile.data;
  const send = async (file) => {
    if (!file) return;
    setName(file.name);
    setProblem(file.size > MAX_TRY ? "A file to try can be at most 2 MB" : null);
    if (file.size > MAX_TRY) return;
    tryFile.mutate({ settings, fileName: file.name, contentBase64: await fileToBase64(file) });
  };
  const features = result?.units?.flatMap((u) => u.features.map((f) => ({ ...f, part: u.reference }))) ?? [];
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border-color p-3" aria-label="Try a file">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-primary-text">Try a file</h3>
          <p className="text-xs text-secondary-text">Read a real export with these settings to see what Fortress finds. Nothing is saved.</p>
        </div>
        <CTAButton type="secondary" size="md" icon={UploadIcon} disabled={disabled} loading={tryFile.isPending} onClick={() => input.current?.click()}>
          {name ? "Try another file" : "Choose a file"}
        </CTAButton>
        <input ref={input} type="file" accept=".csv,.txt,.xlsx" className="hidden" data-testid="try-file" onChange={(e) => { send(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {problem && <Callout tone="error">{problem}</Callout>}
      {tryFile.error && <Callout tone="error">{describeApiError(tryFile.error)}</Callout>}
      {result && !result.ok && <Callout tone="error" title={`${name} could not be read`}>{result.error}</Callout>}
      {result?.ok && (
        <>
          <Callout tone="success" title={`${name}: ${result.featureCount} feature${result.featureCount === 1 ? "" : "s"} in ${result.units.length} part${result.units.length === 1 ? "" : "s"}`}>
            Column headings on line {result.headingRow}.
            {Object.keys(result.header).length > 0 && ` From the lines above: ${Object.entries(result.header).map(([k, v]) => `${HEADER_LABELS.find((h) => h.key === k)?.label ?? k} ${v}`).join(", ")}.`}
          </Callout>
          {result.warnings.map((w) => <Callout key={w} tone="warning">{w}</Callout>)}
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-sm" aria-label="Features found">
              <thead>
                <tr className="text-left text-xs text-secondary-text">
                  <th className="px-2 py-1 font-normal">Feature</th>
                  <th className="px-2 py-1 font-normal">Balloon</th>
                  <th className="px-2 py-1 font-normal">Value</th>
                  <th className="px-2 py-1 font-normal">Limits</th>
                  {result.units.length > 1 && <th className="px-2 py-1 font-normal">Part</th>}
                </tr>
              </thead>
              <tbody>
                {features.slice(0, 50).map((f) => (
                  <tr key={f.position} className="border-t border-border-color">
                    <td className="px-2 py-1 text-primary-text">{f.featureName}</td>
                    <td className="px-2 py-1 text-primary-text">{f.balloon ?? "—"}</td>
                    <td className="px-2 py-1 tabular-nums text-primary-text">{f.actual ?? (f.pass == null ? f.actualText ?? "—" : f.pass ? "Pass" : "Fail")}{f.unit && f.actual != null ? ` ${f.unit}` : ""}</td>
                    <td className="px-2 py-1 tabular-nums text-secondary-text">{limitsWords(f.lower, f.upper, f.unit)}</td>
                    {result.units.length > 1 && <td className="px-2 py-1 text-secondary-text">{f.part ?? "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {features.length > 50 && <p className="text-xs text-secondary-text">The first 50 of {features.length} are shown.</p>}
        </>
      )}
    </section>
  );
};

/** Create a profile (from a ready-made one) or change one: columns, header labels and how values are read. A change to how files are read needs a reason. */
const ProfileDialog = ({ profile, onClose }) => {
  const templates = useProfileTemplates();
  const gauges = useGauges({ pageSize: 200, sort: "assetNumber" });
  const mutation = useProfileMutation();
  const [name, setName] = useState(profile?.name ?? "");
  const [description, setDescription] = useState(profile?.description ?? "");
  const [gaugeId, setGaugeId] = useState(profile?.defaultGauge?.id ?? null);
  const [form, setForm] = useState(() => settingsToForm(profile?.settings));
  const [reason, setReason] = useState("");
  const [template, setTemplate] = useState(null);
  const original = useMemo(() => JSON.stringify(formToSettings(settingsToForm(profile?.settings))), [profile]);
  const settings = formToSettings(form);
  const settingsChanged = !!profile && JSON.stringify(settings) !== original;
  const problems = settingsProblems(form);
  const set = (path, value) =>
    setForm((f) => (path.includes(".") ? { ...f, [path.split(".")[0]]: { ...f[path.split(".")[0]], [path.split(".")[1]]: value } } : { ...f, [path]: value }));
  const pickTemplate = (key) => {
    setTemplate(key);
    const t = (templates.data?.data ?? []).find((x) => x.key === key);
    if (!t) return;
    setForm(settingsToForm(t.settings));
    if (!name.trim()) setName(t.name);
    if (!description.trim()) setDescription(t.description);
  };
  const ready = name.trim() && problems.length === 0 && (!settingsChanged || reason.trim().length >= 3);
  const save = () => {
    const body = { name: name.trim(), description: description.trim() || null, defaultGaugeId: gaugeId ?? null, settings };
    mutation.mutate(
      profile ? { action: "update", id: profile.id, body: { ...body, settings: settingsChanged ? settings : undefined, reason: settingsChanged ? reason.trim() : undefined } } : { action: "create", body },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog title={profile ? `Change ${profile.name}` : "New measurement file profile"} onClose={onClose} width="max-w-4xl">
      <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1">
        {!profile && (
          <ComboField
            label="Start from"
            value={template}
            onChange={pickTemplate}
            options={(templates.data?.data ?? []).map((t) => ({ value: t.key, label: t.name, hint: t.description }))}
            placeholder="A blank profile"
            hint="A ready-made profile fills in the usual column names; check them with Try a file."
          />
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <ComboField
            label="Default gauge"
            value={gaugeId}
            onChange={setGaugeId}
            options={(gauges.data?.data ?? []).map((g) => ({ value: g.id, label: g.assetNumber, hint: g.description }))}
            hint="The CMM this profile is for; it can be changed on each import."
          />
          <TextAreaField label="Description" className="md:col-span-2" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold text-primary-text">Columns</legend>
          <p className="text-xs text-secondary-text">The heading of each column, as the file writes it (matched ignoring case). Leave out those the file does not have.</p>
          <div className="grid gap-3 md:grid-cols-3">
            {COLUMN_FIELDS.map((c) => (
              <Field key={c.key} label={c.label} required={c.required} value={form.columns[c.key]} onChange={(e) => set(`columns.${c.key}`, e.target.value)} maxLength={200} />
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-3 md:grid-cols-3">
          <legend className="mb-1 text-sm font-semibold text-primary-text">Reading the file</legend>
          <ComboField label="Separator" required value={form.delimiter} onChange={(v) => set("delimiter", v ?? "auto")} options={DELIMITERS} />
          <ComboField label="Character set" required value={form.encoding} onChange={(v) => set("encoding", v ?? "auto")} options={ENCODINGS} />
          <Field label="Line of the column headings" value={form.headingRow} onChange={(e) => set("headingRow", e.target.value)} inputMode="numeric" hint="Empty: the first line with the feature and value headings." />
          <ComboField label="Decimal mark" required value={form.decimal} onChange={(v) => set("decimal", v ?? ".")} options={[{ value: ".", label: "Point (25.05)" }, { value: ",", label: "Comma (25,05)" }]} />
          <ComboField
            label="Lower tolerance"
            required
            value={form.lowerTolerance}
            onChange={(v) => set("lowerTolerance", v ?? "as_written")}
            options={[{ value: "as_written", label: "As written (−0.05 is below the nominal)" }, { value: "minus", label: "Always below the nominal (0.05 means −0.05)" }]}
          />
          <ComboField
            label="Balloon numbers"
            required
            value={form.balloonFrom}
            onChange={(v) => set("balloonFrom", v ?? "feature")}
            options={[{ value: "feature", label: "From the feature name (12_DIA, #12)" }, { value: "column", label: "From the balloon column" }, { value: "none", label: "Not used" }]}
          />
          <Field label="Unit of the values" value={form.unit} onChange={(e) => set("unit", e.target.value)} hint="When the file has no unit column, e.g. mm or in." maxLength={20} />
          <Field label="Words for pass" value={form.passValues} onChange={(e) => set("passValues", e.target.value)} hint="Separated by commas." />
          <Field label="Words for fail" value={form.failValues} onChange={(e) => set("failValues", e.target.value)} hint="Separated by commas." />
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold text-primary-text">Lines above the table</legend>
          <p className="text-xs text-secondary-text">The words before each value, e.g. “Part number” for a line “Part number: 123-A”. A part number that is not the inspection&apos;s part stops the import.</p>
          <div className="grid gap-3 md:grid-cols-3">
            {HEADER_LABELS.map((h) => (
              <Field key={h.key} label={h.label} value={form.header[h.key]} onChange={(e) => set(`header.${h.key}`, e.target.value)} maxLength={100} />
            ))}
          </div>
        </fieldset>

        <TryFile settings={settings} disabled={problems.length > 0} />

        {settingsChanged && (
          <TextAreaField label={`Why is the way files are read changing? (becomes version ${profile.currentVersion + 1})`} required value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        )}
        {problems.length > 0 && (
          <Callout tone="warning" title="Still needed">
            <ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Callout>
        )}
        {mutation.error && <Callout tone="error" role="alert">{describeApiError(mutation.error)}</Callout>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
        <CTAButton type="main" size="md" disabled={!ready} loading={mutation.isPending} onClick={save}>{profile ? "Save" : "Add profile"}</CTAButton>
      </div>
    </Dialog>
  );
};

const RetireDialog = ({ profile, onClose }) => {
  const mutation = useProfileMutation();
  const [reason, setReason] = useState("");
  return (
    <Dialog title={`Retire ${profile.name}?`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-primary-text">It reads no more files. Imports already made keep the version they used. It can be brought back.</p>
        <TextAreaField label="Why" required value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        {mutation.error && <Callout tone="error" role="alert">{describeApiError(mutation.error)}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton type="danger" size="md" disabled={reason.trim().length < 3} loading={mutation.isPending} onClick={() => mutation.mutate({ action: "retire", id: profile.id, reason: reason.trim() }, { onSuccess: onClose })}>
            Retire
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** Settings → Data Management → Process control: how measurement files from CMMs and other gauge software are read (CM4). */
const MeasurementProfilesCard = () => {
  const profiles = useMeasurementProfiles({ all: true });
  const mutation = useProfileMutation();
  const [editing, setEditing] = useState(null); // profile | "new"
  const [retiring, setRetiring] = useState(null);
  const canManage = profiles.data?.canManage;
  const list = profiles.data?.data ?? [];
  return (
    <MenuCard
      title="Measurement files"
      subtitle="How report files from a CMM or other gauge software are read, so inspectors can import them instead of typing readings."
      action={canManage ? <CTAButton type="main" icon={PlusIcon} onClick={() => setEditing("new")}>New profile</CTAButton> : null}>
      {profiles.error ? (
        <Callout tone="error">{describeApiError(profiles.error)}</Callout>
      ) : list.length === 0 ? (
        <p className="text-sm text-secondary-text">No profiles yet{canManage ? ": start from a ready-made one for ZEISS CALYPSO, PC-DMIS or a simple table." : "."}</p>
      ) : (
        <ul aria-label="Measurement file profiles" className="flex flex-col divide-y divide-border-color">
          {list.map((p) => (
            <li key={p.id} className={`flex flex-wrap items-center gap-3 py-2 ${p.active ? "" : "opacity-70"}`}>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-primary-text">{p.name}{!p.active && <span className="ml-2 rounded-full bg-border-color px-2 py-0.5 text-xs text-secondary-text">Retired</span>}</span>
                <span className="text-xs text-secondary-text">
                  Version {p.currentVersion}{p.defaultGauge ? ` · ${p.defaultGauge.assetNumber}` : ""}{p.description ? ` · ${p.description}` : ""}{p.retiredReason ? ` · Retired: ${p.retiredReason}` : ""}
                </span>
              </div>
              {canManage && (
                <RowActionsMenu
                  label={`Actions for ${p.name}`}
                  items={[
                    p.active && { label: "Change", onSelect: () => setEditing(p) },
                    p.active && { label: "Retire", tone: "danger", onSelect: () => setRetiring(p) },
                    !p.active && { label: "Bring back", onSelect: () => mutation.mutate({ action: "reactivate", id: p.id }) },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <ProfileDialog profile={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {retiring && <RetireDialog profile={retiring} onClose={() => setRetiring(null)} />}
    </MenuCard>
  );
};

export default MeasurementProfilesCard;
