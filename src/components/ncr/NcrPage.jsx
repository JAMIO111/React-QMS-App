import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { ArrowLeftIcon, RotateCcwIcon, Trash2Icon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions, useSites } from "../../hooks/useQmsApi";
import { useClassifications, useEmployees, useNcr, useNcrHistory, useNcrMutation } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";
import { FIELD_LABELS, NC_TYPES, SEVERITIES, STAGES, formatDate, nextStages, stageOf } from "../../lib/ncr";
import { SeverityPill, StagePill } from "./Pills";
import DeleteNcrDialog from "./DeleteNcrDialog";
import { PartPicker, PartyPicker, RevisionPicker, SelectField, TextAreaField } from "./Pickers";

const EMPTY = {
  title: "", severity: null, description: "", requirement: "", actualResult: "", siteId: null, detectedAt: new Date().toISOString().slice(0, 10),
  detectionProcessId: null, partId: null, partRevisionId: null, lotNumber: "", serialNumber: "", quantityAffected: "", quantityInspected: "",
  customerId: null, customerReference: "", supplierId: null, purchaseOrder: "", workOrder: "",
  failureModeId: null, subFailureModeId: null, causalProcessId: null, responsibleEmployeeId: null,
};

/** API record → form values. */
const toForm = (n) => ({
  title: n.title ?? "", severity: n.severity, description: n.description ?? "", requirement: n.requirement ?? "", actualResult: n.actualResult ?? "",
  siteId: n.site?.id ?? null, detectedAt: n.detectedAt, detectionProcessId: n.detectionProcess?.id ?? null,
  partId: n.part?.id ?? null, partRevisionId: n.partRevisionId ?? null, lotNumber: n.lotNumber ?? "", serialNumber: n.serialNumber ?? "",
  quantityAffected: n.quantityAffected ?? "", quantityInspected: n.quantityInspected ?? "",
  customerId: n.customer?.id ?? null, customerReference: n.customerReference ?? "", supplierId: n.supplier?.id ?? null,
  purchaseOrder: n.purchaseOrder ?? "", workOrder: n.workOrder ?? "",
  failureModeId: n.failureMode?.id ?? null, subFailureModeId: n.subFailureMode?.id ?? null, causalProcessId: n.causalProcess?.id ?? null,
  responsibleEmployeeId: n.responsibleEmployee?.id ?? null,
});

/** Form values → API body (empty strings → null, quantities → numbers). Only fields relevant to the source. */
const toBody = (form, source) => {
  const body = { ...form, title: form.title.trim() };
  for (const k of ["quantityAffected", "quantityInspected"]) body[k] = form[k] === "" || form[k] === null ? null : Number(form[k]);
  for (const [k, v] of Object.entries(body)) if (typeof v === "string" && k !== "title" && k !== "detectedAt") body[k] = v.trim() === "" ? null : v.trim();
  if (source !== "customer") { delete body.customerId; delete body.customerReference; }
  if (source !== "supplier") { delete body.supplierId; delete body.purchaseOrder; }
  if (source === "supplier") delete body.workOrder;
  return body;
};

const changedFields = (body, original) => Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(original[k] ?? null)));

const Section = ({ title, children }) => (
  <fieldset className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4">
    <legend className="px-1 text-sm font-semibold text-primary-text">{title}</legend>
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>
  </fieldset>
);

/** Reason dialog for cancelling or reopening. */
const ReasonDialog = ({ title, label, confirmText, onConfirm, onClose, pending, error }) => {
  const [reason, setReason] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(reason.trim());
        }}
        className="flex flex-col gap-3">
        <TextAreaField label={label} value={reason} onChange={setReason} maxLength={1000} />
        {error && (
          <p role="alert" className="text-sm text-error-color">
            {describeApiError(error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
            Back
          </button>
          <button type="submit" disabled={pending || reason.trim().length < 3} className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
            {pending ? "Saving…" : confirmText}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

const StageBar = ({ ncr, canUpdate, dirty, onMove, onCancel, onReopen, pending }) => {
  const options = nextStages(ncr.stage);
  const shown = STAGES.filter((s) => s.key !== "cancelled" || ncr.stage === "cancelled");
  const current = STAGES.findIndex((s) => s.key === ncr.stage);
  const blocked = !canUpdate || !!ncr.deletedAt;
  return (
    <section aria-label="Stage" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4">
      <ol className="flex flex-wrap items-center gap-1 text-xs">
        {shown.map((s, i) => (
          <li key={s.key} aria-current={s.key === ncr.stage ? "step" : undefined}
            className={`rounded-full px-2 py-1 ${s.key === ncr.stage ? s.tone + " font-semibold" : i < current && ncr.stage !== "cancelled" ? "text-primary-text" : "text-secondary-text"}`}>
            {s.label}
          </li>
        ))}
      </ol>
      {ncr.stageReason && (
        <p className="text-sm text-secondary-text">
          Last stage change: <span className="text-primary-text">{ncr.stageReason}</span>
        </p>
      )}
      {!blocked && (
        <div className="flex flex-wrap items-center gap-2">
          {options.forward.slice(0, 1).map((to) => (
            <button key={to} type="button" disabled={pending || dirty} onClick={() => onMove(to)}
              className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
              {to === "open" ? "Open this NC" : `Move to ${stageOf(to).label}`}
            </button>
          ))}
          {options.forward.length > 1 && (
            <select aria-label="Move to a later stage" disabled={pending || dirty} value="" onChange={(e) => e.target.value && onMove(e.target.value)}
              className="rounded-lg border border-border-color bg-text-input-color px-2 py-1.5 text-sm text-primary-text">
              <option value="">Skip to…</option>
              {options.forward.slice(1).map((to) => (
                <option key={to} value={to}>
                  {stageOf(to).label}
                </option>
              ))}
            </select>
          )}
          {options.cancel && (
            <button type="button" disabled={pending || dirty} onClick={onCancel} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 cursor-pointer">
              Cancel NC
            </button>
          )}
          {options.reopen && (
            <button type="button" disabled={pending} onClick={onReopen} className="flex items-center gap-1 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 cursor-pointer">
              <RotateCcwIcon className="h-4 w-4" /> Reopen
            </button>
          )}
          {dirty && <span className="text-sm text-secondary-text">Save your changes before changing the stage.</span>}
        </div>
      )}
    </section>
  );
};

const describeValue = (v) => (v === null || v === undefined || v === "" ? "—" : /^[0-9a-f-]{36}$/i.test(String(v)) ? null : String(v));

const History = ({ id }) => {
  const { data, isLoading, error } = useNcrHistory(id);
  if (isLoading) return <p className="text-secondary-text">Loading history…</p>;
  if (error) return <p role="alert" className="text-error-color">{describeApiError(error)}</p>;
  return (
    <ol className="flex flex-col gap-3">
      {data.map((e) => {
        const fields = e.action === "insert" ? [] : e.changedFields.filter((f) => !["updated_at", "updated_by"].includes(f));
        return (
          <li key={e.id} className="rounded-xl border border-border-color bg-secondary-bg p-3 text-sm">
            <p className="text-primary-text">
              <strong>{e.actor?.name ?? "System"}</strong> {e.action === "insert" ? "created this record" : "changed"}{" "}
              <span className="text-secondary-text">· {new Date(e.at).toLocaleString("en-GB")}</span>
              {e.reason && <span className="text-secondary-text"> · “{e.reason}”</span>}
            </p>
            {fields.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-secondary-text">
                {fields.map((f) => {
                  const from = describeValue(e.previous?.[f]);
                  const to = describeValue(e.current?.[f]);
                  return (
                    <li key={f}>
                      {FIELD_LABELS[f] ?? f}
                      {from !== null && to !== null ? `: ${from} → ${to}` : " changed"}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
};

/** Create or view/edit an NCR: /Non-Conformance/:type/new and /Non-Conformance/:type/:id. */
const NcrPage = () => {
  const { type, id: routeId } = useParams();
  const isNew = routeId === "new";
  const ncType = NC_TYPES[type];
  const source = ncType?.source;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const { data: ncr, isLoading, error } = useNcr(isNew ? null : routeId);
  const { data: lists } = useClassifications();
  const { data: employees } = useEmployees();
  const { data: sites } = useSites();
  const mutation = useNcrMutation();
  const [form, setForm] = useState(EMPTY);
  const [tab, setTab] = useState("details");
  const [dialog, setDialog] = useState(null); // "cancel" | "reopen" | "delete"

  const original = useMemo(() => (ncr ? toForm(ncr) : EMPTY), [ncr]);
  useEffect(() => setForm(original), [original]);

  if (!ncType) return <Navigate to="/Non-Conformance/Internal" replace />;
  if (!isNew && ncr && ncr.source !== source) return <Navigate to={`/Non-Conformance/${Object.keys(NC_TYPES).find((k) => NC_TYPES[k].source === ncr.source)}/${ncr.id}`} replace />;

  const locked = !isNew && ncr && (ncr.stage === "closed" || ncr.stage === "cancelled" || !!ncr.deletedAt);
  const canEdit = isNew ? can("ncr.create") : can("ncr.update") && !locked;
  const body = toBody(form, source);
  const changes = isNew ? body : changedFields(body, toBody(original, source));
  const dirty = !isNew && Object.keys(changes).length > 0;
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }));

  const save = (open) => {
    if (isNew) {
      mutation.mutate(
        { path: "/ncrs", body: { source, ...body, ...(open ? { open: true } : {}) } },
        {
          onSuccess: (created) => {
            showToast({ type: "success", title: "Saved", message: `${created.reference} was ${open ? "raised" : "saved as a draft"}.` });
            navigate(`/Non-Conformance/${type}/${created.id}`, { replace: true });
          },
        }
      );
    } else {
      mutation.mutate(
        { path: `/ncrs/${ncr.id}`, method: "PATCH", body: changes },
        { onSuccess: () => showToast({ type: "success", title: "Saved", message: "Changes saved." }) }
      );
    }
  };

  const transition = (to, reason) =>
    mutation.mutate(
      { path: `/ncrs/${ncr.id}/transitions`, body: { to, ...(reason ? { reason } : {}) } },
      {
        onSuccess: (updated) => {
          setDialog(null);
          showToast({ type: "success", title: "Stage changed", message: `${updated.reference} is now ${stageOf(updated.stage).label.toLowerCase()}.` });
        },
        onError: (err) => !reason && showToast({ type: "error", title: "Stage not changed", message: describeApiError(err) }),
      }
    );
  const restore = () =>
    mutation.mutate(
      { path: `/ncrs/${ncr.id}/restore` },
      { onSuccess: () => showToast({ type: "success", title: "Restored", message: `${ncr.reference} is back in the register.` }) }
    );

  if (!isNew && isLoading) return <p className="p-4 text-secondary-text">Loading…</p>;
  if (!isNew && error) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Link to={`/Non-Conformance/${type}`} className="text-link-color hover:underline">← {ncType.label} register</Link>
        <p role="alert" className="text-error-color">{describeApiError(error)}</p>
      </div>
    );
  }

  const subs = (lists?.subFailureModes ?? []).filter((s) => s.parentId === form.failureModeId);
  const opt = (items) => (items ?? []).map((c) => ({ value: c.id, label: c.code ? `${c.code} – ${c.name}` : c.name }));

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to={`/Non-Conformance/${type}`} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> {ncType.label} register
      </Link>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-primary-text">{isNew ? `New ${ncType.one}` : ncr.reference}</h1>
        {!isNew && <StagePill stage={ncr.stage} />}
        {!isNew && <SeverityPill severity={ncr.severity} />}
        {!isNew && (
          <span className="text-sm text-secondary-text">
            Raised {formatDate(ncr.createdAt)} by {ncr.createdBy?.name ?? "—"}
            {ncr.closedAt && ` · closed ${formatDate(ncr.closedAt)} by ${ncr.closedBy?.name ?? "—"}`}
          </span>
        )}
        {!isNew && can("ncr.delete") && !ncr.deletedAt && (
          <button type="button" onClick={() => setDialog("delete")} className="ml-auto flex items-center gap-1 rounded-lg border border-error-btn-border bg-error-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-error-btn-bg-hover cursor-pointer">
            <Trash2Icon className="h-4 w-4" /> Delete
          </button>
        )}
      </header>

      {!isNew && ncr.deletedAt && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
          Deleted {formatDate(ncr.deletedAt)} by {ncr.deletedBy?.name ?? "—"}: “{ncr.deleteReason}”.
          {can("ncr.delete") && (
            <button type="button" onClick={restore} disabled={mutation.isPending} className="flex items-center gap-1 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1 hover:bg-neutral-btn-bg-hover cursor-pointer">
              <RotateCcwIcon className="h-4 w-4" /> Restore
            </button>
          )}
        </div>
      )}

      {!isNew && (
        <StageBar
          ncr={ncr}
          canUpdate={can("ncr.update")}
          dirty={dirty}
          pending={mutation.isPending}
          onMove={(to) => transition(to)}
          onCancel={() => setDialog("cancel")}
          onReopen={() => setDialog("reopen")}
        />
      )}

      {!isNew && (
        <div role="tablist" aria-label="Sections" className="flex gap-2 border-b border-border-color">
          {[["details", "Details"], ["history", "History"]].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm cursor-pointer ${tab === k ? "border-theme text-primary-text font-semibold" : "border-transparent text-secondary-text"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === "history" && !isNew ? (
        <History id={ncr.id} />
      ) : (
        <form
          aria-label="Non-conformance details"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save(false);
          }}>
          {locked && (
            <p className="text-sm text-secondary-text">
              {ncr.deletedAt ? "Deleted records are read-only." : `This non-conformance is ${stageOf(ncr.stage).label.toLowerCase()}; reopen it to make changes.`}
            </p>
          )}
          <Section title="What happened">
            <Field label="Title *" value={form.title} onChange={set("title")} disabled={!canEdit} required maxLength={200} className="md:col-span-2 xl:col-span-3" />
            <SelectField label="Severity" value={form.severity} onChange={set("severity")} disabled={!canEdit} options={SEVERITIES.map((s) => ({ value: s.key, label: s.label }))} hint="Needed to open" />
            <Field label="Detected on" type="date" value={form.detectedAt} onChange={set("detectedAt")} disabled={!canEdit} required />
            <SelectField label="Where detected" value={form.detectionProcessId} onChange={set("detectionProcessId")} disabled={!canEdit} options={opt(lists?.processes)} />
            <SelectField label="Site" value={form.siteId} onChange={set("siteId")} disabled={!canEdit} options={(sites?.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} />
            <TextAreaField label="Description" value={form.description} onChange={set("description")} disabled={!canEdit} maxLength={5000} className="md:col-span-2 xl:col-span-3" />
            <TextAreaField label="Requirement / specification" value={form.requirement} onChange={set("requirement")} disabled={!canEdit} rows={2} maxLength={2000} />
            <TextAreaField label="Actual result" value={form.actualResult} onChange={set("actualResult")} disabled={!canEdit} rows={2} maxLength={2000} />
          </Section>

          <Section title={source === "customer" ? "Customer and product" : source === "supplier" ? "Supplier and product" : "Product"}>
            {source === "customer" && (
              <>
                <PartyPicker kind="customers" label="Customer" value={form.customerId} current={ncr?.customer} onChange={set("customerId")} disabled={!canEdit} required />
                <Field label="Customer reference" value={form.customerReference} onChange={set("customerReference")} disabled={!canEdit} maxLength={60} hint="Their complaint or claim number" />
              </>
            )}
            {source === "supplier" && (
              <>
                <PartyPicker kind="suppliers" label="Supplier" value={form.supplierId} current={ncr?.supplier} onChange={set("supplierId")} disabled={!canEdit} required />
                <Field label="Purchase order" value={form.purchaseOrder} onChange={set("purchaseOrder")} disabled={!canEdit} maxLength={60} />
              </>
            )}
            {source !== "supplier" && <Field label="Work order" value={form.workOrder} onChange={set("workOrder")} disabled={!canEdit} maxLength={60} />}
            <PartPicker value={form.partId} current={ncr?.part} disabled={!canEdit} onChange={(v) => setForm((f) => ({ ...f, partId: v, partRevisionId: null }))} />
            <RevisionPicker partId={form.partId} value={form.partRevisionId} onChange={set("partRevisionId")} disabled={!canEdit} />
            <Field label="Lot / batch" value={form.lotNumber} onChange={set("lotNumber")} disabled={!canEdit} maxLength={60} />
            <Field label="Serial number" value={form.serialNumber} onChange={set("serialNumber")} disabled={!canEdit} maxLength={60} />
            <Field label="Quantity affected" type="number" min="0" step="any" value={form.quantityAffected} onChange={set("quantityAffected")} disabled={!canEdit} hint="Needed to open" />
            <Field label="Quantity inspected" type="number" min="0" step="any" value={form.quantityInspected} onChange={set("quantityInspected")} disabled={!canEdit} />
          </Section>

          <Section title="Classification">
            <SelectField label="Failure mode" value={form.failureModeId} disabled={!canEdit} options={opt(lists?.failureModes)}
              onChange={(v) => setForm((f) => ({ ...f, failureModeId: v, subFailureModeId: null }))} />
            <SelectField label="Sub-failure mode" value={form.subFailureModeId} onChange={set("subFailureModeId")} disabled={!canEdit || !form.failureModeId} options={opt(subs)}
              placeholder={form.failureModeId ? "— None —" : "Choose a failure mode first"} />
            <SelectField label="Causal process" value={form.causalProcessId} onChange={set("causalProcessId")} disabled={!canEdit} options={opt(lists?.processes)} />
            {source !== "supplier" && (
              <SelectField label="Responsible operator" value={form.responsibleEmployeeId} onChange={set("responsibleEmployeeId")} disabled={!canEdit}
                options={(employees ?? []).filter((e) => e.active || e.id === form.responsibleEmployeeId).map((e) => ({ value: e.id, label: e.name }))} />
            )}
          </Section>

          {mutation.error && !dialog && (
            <p role="alert" className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
              {describeApiError(mutation.error)}
            </p>
          )}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {isNew ? (
                <>
                  <button type="button" onClick={() => save(true)} disabled={mutation.isPending || !form.title.trim()} className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-4 py-2 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
                    {mutation.isPending ? "Saving…" : "Raise NC"}
                  </button>
                  <button type="submit" disabled={mutation.isPending || !form.title.trim()} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-4 py-2 text-sm text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 cursor-pointer">
                    Save as draft
                  </button>
                </>
              ) : (
                <>
                  <button type="submit" disabled={mutation.isPending || !dirty || !form.title.trim()} className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-4 py-2 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
                    {mutation.isPending ? "Saving…" : "Save changes"}
                  </button>
                  {dirty && (
                    <button type="button" onClick={() => setForm(original)} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-4 py-2 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
                      Discard changes
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </form>
      )}

      {dialog === "cancel" && (
        <ReasonDialog title={`Cancel ${ncr.reference}?`} label="Why is it being cancelled?" confirmText="Cancel NC" pending={mutation.isPending} error={mutation.error}
          onClose={() => setDialog(null)} onConfirm={(reason) => transition("cancelled", reason)} />
      )}
      {dialog === "reopen" && (
        <ReasonDialog title={`Reopen ${ncr.reference}?`} label="Why is it being reopened?" confirmText="Reopen" pending={mutation.isPending} error={mutation.error}
          onClose={() => setDialog(null)} onConfirm={(reason) => transition("open", reason)} />
      )}
      {dialog === "delete" && <DeleteNcrDialog ncr={ncr} onClose={() => setDialog(null)} onDeleted={() => navigate(`/Non-Conformance/${type}`)} />}
    </div>
  );
};

export default NcrPage;
