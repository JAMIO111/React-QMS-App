import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useAuth } from "../../contexts/AuthProvider";
import { useCustomFieldPeople } from "../../hooks/useCustomFields";
import { useAllDepartments, useSites } from "../../hooks/useQmsApi";
import { useRiskCategories, useRiskModel, useRiskMutation } from "../../hooks/useRisk";
import { BAND_LABEL, BAND_PILL, cellBand, isAcceptable, RISK_KINDS } from "../../lib/risk";
import { FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RiskMatrix from "./RiskMatrix";

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

/** Raise a risk or an opportunity, or change its details. The kind is fixed once it has been assessed. */
export const RiskDialog = ({ existing, onClose, onSaved }) => {
  const mutation = useRiskMutation();
  const categories = useRiskCategories();
  const people = useCustomFieldPeople();
  const sites = useSites();
  const departments = useAllDepartments();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [kind, setKind] = useState(existing?.kind ?? "risk");
  const [categoryId, setCategoryId] = useState(existing?.category.id ?? null);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [cause, setCause] = useState(existing?.cause ?? "");
  const [effect, setEffect] = useState(existing?.effect ?? "");
  const [ownerId, setOwnerId] = useState(existing?.owner?.id ?? user?.id ?? null);
  const [siteId, setSiteId] = useState(existing?.site?.id ?? null);
  const [departmentId, setDepartmentId] = useState(existing?.department?.id ?? null);

  const kindFixed = existing && existing.status !== "draft";
  const categoryOptions = (categories.data?.data ?? []).map((c) => ({ value: c.id, label: c.label, hint: c.description ?? undefined }));
  // A category switched off since stays on the risk that has it.
  if (existing && !categoryOptions.some((c) => c.value === existing.category.id)) categoryOptions.push({ value: existing.category.id, label: existing.category.label, hint: "Switched off" });
  const personOptions = (people.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const siteOptions = (sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.code }));
  const departmentOptions = (departments.data?.data ?? []).filter((d) => !siteId || d.siteId === siteId).map((d) => ({ value: d.id, label: d.name, hint: d.code }));
  const opportunity = kind === "opportunity";
  const ready = title.trim() && categoryId && ownerId;

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = {
      categoryId, title: title.trim(), description: description.trim() || null, cause: cause.trim() || null, effect: effect.trim() || null,
      ownerId, siteId: siteId ?? null, departmentId: departmentId ?? null,
    };
    if (!kindFixed) body.kind = kind;
    mutation.mutate(existing ? { action: "update", id: existing.id, body } : { action: "create", body }, {
      onSuccess: (risk) => {
        onSaved?.(risk);
        onClose();
      },
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });
  };

  return (
    <Dialog title={existing ? `Edit ${existing.reference}` : "Raise a risk or an opportunity"} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField label="It is" required value={kind} onChange={(v) => setKind(v ?? "risk")} options={RISK_KINDS} disabled={kindFixed} hint={kindFixed ? "Fixed once it has been assessed" : undefined} />
          <ComboField label="Category" required value={categoryId} onChange={setCategoryId} options={categoryOptions} placeholder="Choose a category" />
        </div>
        <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder={opportunity ? "e.g. A second CMM shift" : "e.g. Single source for castings"} />
        <TextAreaField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={2} hint="Optional: what it is about" />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextAreaField label="Cause" value={cause} onChange={(e) => setCause(e.target.value)} maxLength={2000} rows={2} hint={opportunity ? "What makes it possible" : "Why it could happen"} />
          <TextAreaField label="Effect" value={effect} onChange={(e) => setEffect(e.target.value)} maxLength={2000} rows={2} hint={opportunity ? "What would be gained" : "What it would do"} />
        </div>
        <ComboField label="Owner" required value={ownerId} onChange={setOwnerId} options={personOptions} placeholder="Who looks after it" />
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboField
            label="Site"
            value={siteId}
            onChange={(v) => {
              setSiteId(v);
              setDepartmentId(null);
            }}
            options={siteOptions}
            placeholder="The whole organisation"
            clearable
          />
          <ComboField label="Department" value={departmentId} onChange={setDepartmentId} options={departmentOptions} placeholder="Any" clearable />
        </div>
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={existing ? "Save" : "Raise it"} />
      </form>
    </Dialog>
  );
};

/** Assess before treatment: choose a cell of the matrix and say why. The server works the score out again from the matrix in force. */
export const AssessDialog = ({ risk, onClose }) => {
  const mutation = useRiskMutation();
  const model = useRiskModel();
  const { showToast } = useToast();
  const [cell, setCell] = useState(risk.inherent ? { likelihood: risk.inherent.likelihood, consequence: risk.inherent.consequence } : null);
  const [rationale, setRationale] = useState("");
  const config = model.data?.config;
  const band = cell && config ? cellBand(config, cell.likelihood, cell.consequence) : null;
  const opportunity = risk.kind === "opportunity";
  const ready = cell && rationale.trim().length >= 3;
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    mutation.mutate(
      { action: "assess", id: risk.id, body: { ...cell, rationale: rationale.trim() } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not assessed", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={`Assess ${risk.reference}`} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          {opportunity
            ? "How likely is it, and how much would it gain, as things stand? Choose the cell where the two meet."
            : "How likely is it, and how bad would it be, as things stand, before anything more is done about it? Choose the cell where the two meet."}
        </p>
        {model.isLoading ? (
          <p className="text-sm text-secondary-text">Loading the matrix…</p>
        ) : (
          <RiskMatrix config={config} selected={cell} onPick={(likelihood, consequence) => setCell({ likelihood, consequence })} ariaLabel="Choose likelihood and consequence" />
        )}
        <p aria-live="polite" className="text-sm text-primary-text">
          {cell && band ? (
            <>
              {config.likelihood[cell.likelihood - 1].label} × {config.consequence[cell.consequence - 1].label} = <strong>{cell.likelihood * cell.consequence}</strong>{" "}
              <span className={`ml-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[band]}`}>{BAND_LABEL[band]}</span>
            </>
          ) : (
            "Nothing chosen yet."
          )}
        </p>
        {cell && band && !opportunity && !isAcceptable(config, band) && (
          <Callout tone="warning">Above the level your organisation accepts ({BAND_LABEL[config.acceptanceBand].toLowerCase()}): it will need treatment, or an approved acceptance.</Callout>
        )}
        <TextAreaField label="Why this score?" value={rationale} onChange={(e) => setRationale(e.target.value)} required maxLength={2000} rows={3} hint={risk.inherent ? "The earlier assessment is kept in the history" : "The evidence or reasoning behind it"} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label="Record the assessment" />
      </form>
    </Dialog>
  );
};

export const RetireDialog = ({ risk, onClose }) => {
  const mutation = useRiskMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const ok = reason.trim().length >= 3;
  const save = (e) => {
    e.preventDefault();
    if (!ok) return;
    mutation.mutate({ action: "retire", id: risk.id, body: { reason: reason.trim() } }, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not retired", message: describeApiError(err) }) });
  };
  return (
    <Dialog title={`Retire ${risk.reference}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">It leaves the register but is kept with its assessments, and can be brought back. Use it for something raised by mistake or no longer relevant.</p>
        <Field label="Why?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ok} label="Retire" type="danger" />
      </form>
    </Dialog>
  );
};
