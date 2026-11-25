import { useRef, useState } from "react";
import { PencilIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useFmeaModel, useFmeaPreview, useImportApGrid, useSaveFmeaModel } from "../../hooks/useFmea";
import { MODEL_KINDS, PRIORITY_PILL, SCALE_DIMENSIONS, cleanModel, methodLabel, methodWords, modelProblems, priorityLabel, ruleWords } from "../../lib/fmeaModel";
import { formatDay } from "../../lib/fmea";
import { ErrorNotice, FormError } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";

const readText = (file) =>
  typeof file.text === "function"
    ? file.text()
    : new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
      });

const levelOptions = (levels) => levels.map((l, i) => ({ value: String(i + 1), label: `${i + 1} — ${l.label}` }));

/** The ten levels of one scale as a table: the word and, when the organisation wrote it, what the level means. */
const ScaleTable = ({ levels, label }) => (
  <table className="w-full text-left text-sm" aria-label={label}>
    <thead>
      <tr className="text-xs uppercase tracking-wide text-secondary-text">
        <th scope="col" className="w-10 py-1 pr-2">Level</th>
        <th scope="col" className="w-48 py-1 pr-2">Label</th>
        <th scope="col" className="py-1">What it means</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-border-color">
      {levels.map((l, i) => (
        <tr key={i}>
          <td className="py-1.5 pr-2 tabular-nums text-secondary-text">{i + 1}</td>
          <td className="py-1.5 pr-2 font-medium text-primary-text">{l.label}</td>
          <td className="py-1.5 text-secondary-text">{l.criteria || <span className="opacity-60">Not written</span>}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** Choose a kind of FMEA and a scale, and show or edit that scale. */
const ScalePicker = ({ children }) => {
  const [kind, setKind] = useState("process");
  const [dim, setDim] = useState("severity");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <SlidingToggle ariaLabel="Kind of FMEA" mode="radio" value={kind} onChange={setKind} options={MODEL_KINDS.map((k) => ({ value: k.value, label: k.label }))} />
        <SlidingToggle ariaLabel="Scale" mode="radio" value={dim} onChange={setDim} options={SCALE_DIMENSIONS.map((d) => ({ value: d.key, label: d.label }))} />
      </div>
      <p className="text-sm text-secondary-text">{SCALE_DIMENSIONS.find((d) => d.key === dim).hint}</p>
      {children(kind, dim)}
    </div>
  );
};

/** Try S, O and D on a saved version: the database works the answer out, so this is exactly what an FMEA will show. */
const TryRating = ({ model }) => {
  const [kind, setKind] = useState("process");
  const [s, setS] = useState("8");
  const [o, setO] = useState("4");
  const [d, setD] = useState("5");
  const scales = model.config.scales[kind];
  const preview = useFmeaPreview({ kind, severity: Number(s), occurrence: Number(o), detection: Number(d) });
  const r = preview.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <ComboField label="Kind" value={kind} onChange={(v) => v && setKind(v)} options={MODEL_KINDS} />
        <ComboField label="Severity" value={s} onChange={(v) => v && setS(v)} options={levelOptions(scales.severity)} />
        <ComboField label="Occurrence" value={o} onChange={(v) => v && setO(v)} options={levelOptions(scales.occurrence)} />
        <ComboField label="Detection" value={d} onChange={(v) => v && setD(v)} options={levelOptions(scales.detection)} />
      </div>
      {preview.error ? (
        <ErrorNotice error={preview.error} />
      ) : r ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-primary-text" role="status">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${PRIORITY_PILL[r.priority]}`}>{priorityLabel(r.priority)} priority</span>
          <span>
            RPN {r.rpn} ({r.method === "ap" ? "priority from the grid" : "priority from the RPN"})
          </span>
          {r.needsAttention && <span className="text-error-color">Needs attention{r.priority !== "high" ? ": the severity is at or above the floor" : ""}</span>}
        </p>
      ) : null}
    </div>
  );
};

/** Change the model: method and thresholds, the words of each level, the action priority grid (imported from CSV). Saved as a new version with a reason. */
const ModelDialog = ({ model, onClose }) => {
  const save = useSaveFmeaModel();
  const importGrid = useImportApGrid();
  const { showToast } = useToast();
  const fileRef = useRef(null);
  const [config, setConfig] = useState(() => JSON.parse(JSON.stringify(model.config)));
  const [reason, setReason] = useState("");
  const [imported, setImported] = useState(null);
  const changed = JSON.stringify(cleanModel(config)) !== JSON.stringify(cleanModel(model.config));
  const problems = modelProblems(config);
  const ready = changed && problems.length === 0 && reason.trim().length >= 3;
  const setLevel = (kind, dim, i, field, value) =>
    setConfig((c) => ({
      ...c,
      scales: { ...c.scales, [kind]: { ...c.scales[kind], [dim]: c.scales[kind][dim].map((l, n) => (n === i ? { ...l, [field]: value } : l)) } },
    }));

  const readFile = async (file) => {
    if (!file) return;
    const csv = await readText(file);
    importGrid.mutate(csv, {
      onSuccess: (r) => {
        setImported({ ...r, fileName: file.name });
        if (r.covered) setConfig((c) => ({ ...c, apRules: r.rules }));
      },
      onError: (err) => showToast({ type: "error", title: "Could not read the file", message: describeApiError(err) }),
    });
  };
  const submit = (e) => {
    e.preventDefault();
    if (!ready) return;
    save.mutate({ config: cleanModel(config), reason: reason.trim() }, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  };

  return (
    <Dialog title="Change the rating model" onClose={onClose} width="max-w-3xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <p className="text-sm text-secondary-text">
          It is saved as version {model.version + 1}. FMEAs already rated keep the version they were rated with.
        </p>

        <section className="flex flex-col gap-3" aria-label="Method">
          <h3 className="text-base font-semibold text-primary-text">How priority is decided</h3>
          <SlidingToggle
            ariaLabel="Method"
            mode="radio"
            value={config.method}
            onChange={(v) => setConfig((c) => ({ ...c, method: v }))}
            options={[
              { value: "rpn", label: "RPN" },
              { value: "ap", label: "Action priority grid" },
            ]}
          />
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="High from an RPN of" type="number" min="2" max="1000" required value={String(config.rpnHighFrom)} onChange={(e) => setConfig((c) => ({ ...c, rpnHighFrom: e.target.value }))} disabled={config.method === "ap"} />
            <Field label="Medium from an RPN of" type="number" min="1" max="999" required value={String(config.rpnMediumFrom)} onChange={(e) => setConfig((c) => ({ ...c, rpnMediumFrom: e.target.value }))} disabled={config.method === "ap"} />
            <Field label="Always needs attention from severity" type="number" min="1" max="10" required value={String(config.severityFloor)} onChange={(e) => setConfig((c) => ({ ...c, severityFloor: e.target.value }))} />
            <Field label="Review an FMEA every (months)" type="number" min="1" max="120" required value={String(config.reviewMonths)} onChange={(e) => setConfig((c) => ({ ...c, reviewMonths: e.target.value }))} />
          </div>
        </section>

        <section className="flex flex-col gap-3" aria-label="Action priority grid">
          <h3 className="text-base font-semibold text-primary-text">Action priority grid</h3>
          <p className="text-sm text-secondary-text">
            Fortress does not supply a grid: the published one belongs to its publisher. If you hold a licence, import your own as a CSV with a column each for S, O and D (a level or a range such as 1-3) and a Priority column (H, M or L).
            It must cover every combination of S, O and D exactly once.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" aria-label="Choose a CSV file" onChange={(e) => readFile(e.target.files?.[0])} />
            <CTAButton buttonType="button" type="secondary" size="md" onClick={() => fileRef.current?.click()} loading={importGrid.isPending}>
              Import a grid from CSV
            </CTAButton>
            {config.apRules.length > 0 && (
              <CTAButton
                buttonType="button"
                type="neutral"
                size="md"
                onClick={() => {
                  setConfig((c) => ({ ...c, apRules: [], method: "rpn" }));
                  setImported(null);
                }}>
                Remove the grid
              </CTAButton>
            )}
          </div>
          {imported && !imported.covered && (
            <Callout tone="warning" title={`${imported.fileName} cannot be used yet`}>
              <ul className="list-disc pl-5">
                {imported.errors.map((e) => (
                  <li key={`${e.line}-${e.message}`}>{e.line ? `Line ${e.line}: ` : ""}{e.message}</li>
                ))}
                {imported.problem && <li>{imported.problem}</li>}
              </ul>
            </Callout>
          )}
          {config.apRules.length > 0 ? (
            <>
              <p className="text-sm text-primary-text">
                {imported?.covered ? `${imported.fileName} is complete. ` : ""}
                {config.apRules.length} {config.apRules.length === 1 ? "range" : "ranges"} cover every combination.
              </p>
              <ul className="max-h-48 overflow-y-auto rounded-lg border border-border-color p-2 text-sm text-secondary-text" aria-label="Ranges of the grid">
                {config.apRules.map((r, i) => (
                  <li key={i}>{ruleWords(r)}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-secondary-text">No grid. Priority comes from the RPN.</p>
          )}
        </section>

        <section className="flex flex-col gap-3" aria-label="Scales">
          <h3 className="text-base font-semibold text-primary-text">The scales</h3>
          <p className="text-sm text-secondary-text">Words for the ten levels. The criteria are your own wording of what each level means; leave them empty if you only want the labels.</p>
          <ScalePicker>
            {(kind, dim) => (
              <ol className="flex flex-col gap-2" aria-label={`${dim} levels (${kind})`}>
                {config.scales[kind][dim].map((l, i) => (
                  <li key={i} className="grid gap-2 sm:grid-cols-[2.5rem_14rem_1fr] sm:items-end">
                    <span className="hidden pb-2 text-sm tabular-nums text-secondary-text sm:block">{i + 1}</span>
                    <Field label={`Level ${i + 1} label`} required maxLength={40} value={l.label} onChange={(e) => setLevel(kind, dim, i, "label", e.target.value)} />
                    <Field label={`Level ${i + 1} criteria`} maxLength={300} value={l.criteria ?? ""} onChange={(e) => setLevel(kind, dim, i, "criteria", e.target.value)} />
                  </li>
                ))}
              </ol>
            )}
          </ScalePicker>
        </section>

        {problems.length > 0 && (
          <Callout tone="warning" title="Still needed">
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        )}
        <Field label="Why is the model changing?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} />
        <FormError error={save.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready || save.isPending} loading={save.isPending}>
            Save as version {model.version + 1}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Settings → Data Management → FMEA: the rating model (versions). */
const SettingsFmea = () => {
  const model = useFmeaModel();
  const [changing, setChanging] = useState(false);
  if (model.isLoading) return <LoadingScreen />;
  if (model.error) return <ErrorNotice error={model.error} />;
  const m = model.data;
  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Rating model"
        subtitle={`Version ${m.version}. Severity, occurrence and detection are each rated 1 to 10; ${methodLabel(m.config.method).toLowerCase()} decides the priority.`}
        action={
          m.canChange && (
            <CTAButton type="main" icon={PencilIcon} onClick={() => setChanging(true)}>
              Change the model
            </CTAButton>
          )
        }>
        <div className="flex flex-col gap-4">
          {m.config.method === "rpn" && m.config.apRules.length === 0 && (
            <Callout tone="info" title="Rated by RPN">
              No action priority grid has been entered. If you hold a licence for the published grid, an approver can import it here; Fortress does not supply it.
            </Callout>
          )}
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Priority</dt>
              <dd className="text-primary-text">{methodWords(m.config)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Always needs attention</dt>
              <dd className="text-primary-text">Severity {m.config.severityFloor} or more, whatever the priority</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Reviewed every</dt>
              <dd className="text-primary-text">{m.config.reviewMonths} months</dd>
            </div>
          </dl>
          <ScalePicker>{(kind, dim) => <ScaleTable levels={m.config.scales[kind][dim]} label={`${dim} levels (${kind})`} />}</ScalePicker>
          {m.versions.length > 1 && (
            <details>
              <summary className="cursor-pointer text-sm text-secondary-text">Versions ({m.versions.length})</summary>
              <ul className="mt-2 flex flex-col gap-1 text-sm" aria-label="Model versions">
                {m.versions.map((v) => (
                  <li key={v.id} className="text-primary-text">
                    Version {v.version}
                    {v.current ? " (current)" : ""} <span className="text-secondary-text">· {formatDay(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ""}{v.reason ? ` · ${v.reason}` : ""}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </MenuCard>

      <MenuCard title="Try a rating" subtitle="What a severity, occurrence and detection come to on the current version. This is the answer an FMEA will show.">
        <TryRating model={m} />
      </MenuCard>

      {changing && <ModelDialog model={m} onClose={() => setChanging(false)} />}
    </div>
  );
};

export default SettingsFmea;
