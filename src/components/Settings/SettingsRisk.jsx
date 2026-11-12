import { useState } from "react";
import { PencilIcon, PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useRiskCategories, useRiskModel, useRiskMutation, useToggleRiskCategory } from "../../hooks/useRisk";
import { BAND_LABEL, BANDS, formatDay, modelProblems, nextBand } from "../../lib/risk";
import { ErrorNotice, FormError } from "../master-data/shared";
import RiskMatrix from "../risk/RiskMatrix";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";

const CategoryDialog = ({ existing, onClose }) => {
  const mutation = useRiskMutation();
  const { showToast } = useToast();
  const [label, setLabel] = useState(existing?.label ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const save = (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    const body = { label: label.trim(), description: description.trim() || null };
    mutation.mutate(existing ? { action: "updateCategory", id: existing.id, body } : { action: "createCategory", body }, {
      onSuccess: onClose,
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });
  };
  return (
    <Dialog title={existing ? `Edit ${existing.label}` : "Add a category"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Name" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} placeholder="e.g. Tooling" />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} hint="Optional" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!label.trim() || mutation.isPending} loading={mutation.isPending}>
            {existing ? "Save" : "Add category"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Change the matrix: the words for each level, the band of each cell (click a cell to move it on), what is acceptable and how often each band is reviewed. Saved as a new version with a reason. */
const ModelDialog = ({ model, onClose }) => {
  const mutation = useRiskMutation();
  const { showToast } = useToast();
  const [config, setConfig] = useState(() => JSON.parse(JSON.stringify(model.config)));
  const [reason, setReason] = useState("");
  const changed = JSON.stringify(config) !== JSON.stringify(model.config);
  const problems = modelProblems(config);
  const ready = changed && problems.length === 0 && reason.trim().length >= 3;
  const setLabel = (key, i, label) => setConfig((c) => ({ ...c, [key]: c[key].map((l, n) => (n === i ? { ...l, label } : l)) }));
  const cycle = (l, c) => setConfig((cfg) => ({ ...cfg, bands: cfg.bands.map((row, i) => (i === l - 1 ? row.map((b, j) => (j === c - 1 ? nextBand(b) : b)) : row)) }));
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const clean = {
      ...config,
      likelihood: config.likelihood.map((l) => ({ label: l.label.trim(), ...(l.description ? { description: l.description } : {}) })),
      consequence: config.consequence.map((l) => ({ label: l.label.trim(), ...(l.description ? { description: l.description } : {}) })),
      reviewMonths: Object.fromEntries(BANDS.map((b) => [b, Number(config.reviewMonths[b])])),
    };
    mutation.mutate({ action: "saveModel", body: { config: clean, reason: reason.trim() } }, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  };
  return (
    <Dialog title="Change the risk matrix" onClose={onClose} width="max-w-3xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          It is saved as version {model.version + 1}. Assessments already made keep the version they were scored with; assess a risk again to score it on the new one.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {[["likelihood", "Likelihood", "least likely first"], ["consequence", "Consequence", "least serious first"]].map(([key, title, order]) => (
            <fieldset key={key} className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-primary-text">
                {title} <span className="font-normal text-secondary-text">({order})</span>
              </legend>
              {config[key].map((l, i) => (
                <Field key={i} label={`${title} ${i + 1}`} value={l.label} onChange={(e) => setLabel(key, i, e.target.value)} required maxLength={40} />
              ))}
            </fieldset>
          ))}
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-primary-text">Band of each cell</p>
          <p className="mb-2 text-sm text-secondary-text">Click a cell to move it on: low, medium, high, critical.</p>
          <RiskMatrix config={config} onPick={cycle} cellLabel={(l, c, band) => `Likelihood ${l}, consequence ${c}: ${BAND_LABEL[band]}. Change`} ariaLabel="Band of each cell" />
        </div>
        <div className="grid gap-3 sm:grid-cols-5">
          <div className="sm:col-span-1">
            <ComboField
              label="Acceptable up to"
              required
              value={config.acceptanceBand}
              onChange={(v) => v && setConfig((c) => ({ ...c, acceptanceBand: v }))}
              options={["low", "medium", "high"].map((b) => ({ value: b, label: BAND_LABEL[b] }))}
            />
          </div>
          {BANDS.map((b) => (
            <Field
              key={b}
              label={`Review ${BAND_LABEL[b].toLowerCase()} every (months)`}
              type="number"
              min="1"
              max="60"
              required
              value={String(config.reviewMonths[b] ?? "")}
              onChange={(e) => setConfig((c) => ({ ...c, reviewMonths: { ...c.reviewMonths, [b]: e.target.value } }))}
            />
          ))}
        </div>
        {problems.length > 0 && (
          <Callout tone="warning" title="Still needed">
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        )}
        <Field label="Why is the matrix changing?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready || mutation.isPending} loading={mutation.isPending}>
            Save as version {model.version + 1}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Settings → Data Management → Risk: the scoring matrix (versions) and the categories. */
const SettingsRisk = () => {
  const { can } = usePermissions();
  const canManage = can("risk.manage");
  const model = useRiskModel();
  const categories = useRiskCategories({ all: true });
  const toggleCategory = useToggleRiskCategory();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);

  if (model.isLoading || categories.isLoading) return <LoadingScreen />;
  if (model.error) return <ErrorNotice error={model.error} />;
  if (categories.error) return <ErrorNotice error={categories.error} />;
  const m = model.data;
  const toggle = (c) => toggleCategory.mutate({ id: c.id, active: !c.active }, { onError: (err) => showToast({ type: "error", title: "Not changed", message: describeApiError(err) }) });

  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Risk matrix"
        subtitle={`Version ${m.version}. A risk is scored likelihood × consequence; the matrix says which band each score falls in.`}
        action={
          m.canChange && (
            <CTAButton type="main" icon={PencilIcon} onClick={() => setDialog({ model: true })}>
              Change the matrix
            </CTAButton>
          )
        }>
        <div className="flex flex-col gap-4">
          <RiskMatrix config={m.config} />
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Acceptable without approval</dt>
              <dd className="text-primary-text">Up to {BAND_LABEL[m.config.acceptanceBand].toLowerCase()}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Reviewed every</dt>
              <dd className="text-primary-text">{BANDS.map((b) => `${BAND_LABEL[b]} ${m.config.reviewMonths[b]} mo`).join(" · ")}</dd>
            </div>
          </dl>
          {m.versions.length > 1 && (
            <details>
              <summary className="cursor-pointer text-sm text-secondary-text">Versions ({m.versions.length})</summary>
              <ul className="mt-2 flex flex-col gap-1 text-sm" aria-label="Matrix versions">
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

      <MenuCard
        title="Categories"
        subtitle="What kind of risk it is. A category switched off takes no new risks; risks that have it keep it."
        action={
          canManage && (
            <CTAButton type="main" icon={PlusIcon} onClick={() => setDialog({ category: true })}>
              Add category
            </CTAButton>
          )
        }>
        <ul className="-my-3 divide-y divide-border-color" aria-label="Risk categories">
          {categories.data.data.map((c) => (
            <li key={c.id} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${c.active ? "" : "opacity-60"}`}>
              <div className="flex min-w-0 flex-col">
                <span className="font-medium text-primary-text">{c.label}</span>
                <span className="text-sm text-secondary-text">
                  {c.risks} {c.risks === 1 ? "risk" : "risks"}
                  {c.description ? ` · ${c.description}` : ""}
                </span>
              </div>
              {canManage && (
                <div className="flex items-center gap-3">
                  <Switch checked={c.active} onChange={() => toggle(c)}>
                    <span className="sr-only">{c.active ? `Switch ${c.label} off` : `Switch ${c.label} on`}</span>
                  </Switch>
                  <CTAButton type="neutral" icon={PencilIcon} aria-label={`Edit ${c.label}`} onClick={() => setDialog({ category: true, existing: c })} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </MenuCard>

      {dialog?.model && <ModelDialog model={m} onClose={() => setDialog(null)} />}
      {dialog?.category && <CategoryDialog existing={dialog.existing} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default SettingsRisk;
