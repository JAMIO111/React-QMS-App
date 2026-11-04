import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Controller, useForm } from "react-hook-form";
import {
  AlignCenterIcon,
  ArrowLeftIcon,
  BoxIcon,
  ClipboardListIcon,
  FactoryIcon,
  FileTextIcon,
  HashIcon,
  HistoryIcon,
  HouseIcon,
  InboxIcon,
  LayersIcon,
  PoundSterlingIcon,
  QrCodeIcon,
  ReceiptIcon,
  RotateCcwIcon,
  SaveIcon,
  TagIcon,
  TagsIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
  UsersIcon,
  WrenchIcon,
} from "@/components/icons";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import RHFTextArea from "../ui/RHFTextArea";
import TextInput from "../ui/TextInput";
import FileDrop from "../ui/FileDrop";
import SideMenuItem from "../SideMenuItem";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions, useSites } from "../../hooks/useQmsApi";
import { useClassifications, useEmployees, useNcr, useNcrMutation } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";
import { NC_TYPES, SEVERITIES, formatDate, stageOf } from "../../lib/ncr";
import { SeverityPill, StagePill } from "./Pills";
import DeleteNcrDialog from "./DeleteNcrDialog";
import { PartPicker, PartyPicker, RevisionPicker } from "./Pickers";
import ReasonDialog from "./ReasonDialog";
import StageBar from "./StageBar";
import NcrHistory from "./NcrHistory";
import NcrCosts from "./NcrCosts";
import { EMPTY, changedFields, toBody, toForm } from "./formModel";

/** Section title with a rule, as in the original NC entry form. */
const SectionHeading = ({ id, title, sectionRef }) => (
  <div ref={sectionRef} id={id} className="flex scroll-mt-5 flex-row items-center justify-start gap-3 px-2">
    <h2 className="whitespace-nowrap text-2xl text-primary-text">{title}</h2>
    <div className="h-0.5 w-full bg-border-color" />
  </div>
);
const Card = ({ children, className = "" }) => (
  <div className={`flex flex-col gap-4 rounded-2xl bg-secondary-bg p-6 shadow-lg shadow-shadow-color ${className}`}>{children}</div>
);

const btn = {
  save: "flex items-center gap-2 rounded-lg border border-success-btn-border bg-success-btn-bg px-3 py-1 text-primary-text hover:bg-success-btn-bg-hover disabled:opacity-50 cursor-pointer",
  main: "flex items-center gap-2 rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1 text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer",
  neutral: "flex items-center gap-2 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1 text-primary-text hover:bg-neutral-btn-bg-hover disabled:opacity-50 cursor-pointer",
  danger: "flex items-center gap-2 rounded-lg border border-error-btn-border bg-error-btn-bg px-3 py-1 text-primary-text hover:bg-error-btn-bg-hover disabled:opacity-50 cursor-pointer",
};

/**
 * Create or view/edit an NCR (/Non-Conformance/:type/new and /:type/:id), laid out like the
 * original NC entry form: header with Revert / Save, a side menu of sections (NC Details, Cost,
 * Investigation, Additional Info, History) and scrolling cards.
 */
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
  const { control, reset, watch, setValue } = useForm({ defaultValues: EMPTY });
  const form = watch();
  const [dialog, setDialog] = useState(null); // "cancel" | "reopen" | "delete"
  const scrollRef = useRef(null);
  const refs = { details: useRef(null), cost: useRef(null), investigation: useRef(null), info: useRef(null), history: useRef(null) };

  const original = useMemo(() => (ncr ? toForm(ncr) : EMPTY), [ncr]);
  useEffect(() => reset(original), [original, reset]);

  if (!ncType) return <Navigate to="/Non-Conformance/Internal" replace />;
  if (!isNew && ncr && ncr.source !== source) return <Navigate to={`/Non-Conformance/${Object.keys(NC_TYPES).find((k) => NC_TYPES[k].source === ncr.source)}/${ncr.id}`} replace />;

  const locked = !isNew && ncr && (ncr.stage === "closed" || ncr.stage === "cancelled" || !!ncr.deletedAt);
  const canEdit = isNew ? can("ncr.create") : can("ncr.update") && !locked;
  const body = toBody(form, source);
  const changes = isNew ? body : changedFields(body, toBody(original, source));
  const dirty = !isNew && Object.keys(changes).length > 0;
  const set = (k) => (v) => setValue(k, v?.target ? v.target.value : v, { shouldDirty: true });

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
  const opt = (items) => (items ?? []).map((c) => ({ id: c.id, name: c.code ? `${c.code} – ${c.name}` : c.name }));
  /** A react-hook-form controlled field; `then` runs after the value changes (e.g. to clear a dependent field). */
  const controlled = (name, render, then) => (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) =>
        render({
          ...field,
          onChange: (v) => {
            field.onChange(v);
            then?.(v);
          },
          error: fieldState.error,
          disabled: !canEdit,
        })
      }
    />
  );
  const text = (name, label, props = {}) => (
    <TextInput label={label} value={form[name] ?? ""} onChange={set(name)} disabled={!canEdit} placeholder={`Enter ${label.toLowerCase()}`} {...props} />
  );

  const sections = [
    { key: "details", title: "NC Details", subtitle: "Log NC information", icon: ClipboardListIcon },
    { key: "cost", title: "Cost", subtitle: "Track NC expenses", icon: PoundSterlingIcon, needsRecord: true },
    { key: "investigation", title: "Investigation", subtitle: "Classify the cause", icon: WrenchIcon },
    { key: "info", title: "Additional Info", subtitle: "Files and attachments", icon: InboxIcon, needsRecord: true },
    { key: "history", title: "History", subtitle: "Who changed what", icon: HistoryIcon, needsRecord: true },
  ];
  const goTo = (key) => refs[key].current?.scrollIntoView?.({ behavior: "smooth", block: "start" });

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 grow flex-col overflow-hidden bg-primary-bg">
      {/* Header: back to the register, title, and the save / revert actions. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-color bg-primary-bg px-5 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3 py-2">
          <Link to={`/Non-Conformance/${type}`} className="flex items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon className="h-4 w-4" /> {ncType.label} register
          </Link>
          <h1 className="text-xl font-semibold text-primary-text">{isNew ? `New ${ncType.one}` : ncr.reference}</h1>
          {!isNew && <SeverityPill severity={ncr.severity} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isNew && canEdit && (
            <>
              <button type="submit" form="ncr-form" disabled={mutation.isPending || !form.title.trim()} className={btn.neutral}>
                Save as draft
              </button>
              <button type="button" onClick={() => save(true)} disabled={mutation.isPending || !form.title.trim()} className={btn.save}>
                <SaveIcon className="h-4 w-4" /> {mutation.isPending ? "Saving…" : "Raise NC"}
              </button>
            </>
          )}
          {!isNew && canEdit && (
            <>
              {dirty && (
                <button type="button" onClick={() => reset(original)} className={btn.neutral}>
                  <Undo2Icon className="h-4 w-4" /> Discard changes
                </button>
              )}
              <button type="submit" form="ncr-form" disabled={mutation.isPending || !dirty || !form.title.trim()} className={btn.save}>
                <SaveIcon className="h-4 w-4" /> {mutation.isPending ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
          {!isNew && can("ncr.delete") && !ncr.deletedAt && (
            <button type="button" onClick={() => setDialog("delete")} className={btn.danger}>
              <Trash2Icon className="h-4 w-4" /> Delete
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Side menu of sections, as in the original form. */}
        <nav aria-label="Sections" className="hidden h-full w-70 shrink-0 flex-col overflow-y-auto border-r border-border-color bg-primary-bg px-3 md:flex">
          <div className="mb-2 flex flex-col gap-2 border-b border-border-dark-color pb-3 pt-4">
            {isNew ? <span className="text-sm text-secondary-text">Not saved yet</span> : <StagePill stage={ncr.stage} />}
          </div>
          {sections.map((s, i, arr) => {
            const disabled = isNew && !!s.needsRecord;
            return (
              <button key={s.key} type="button" disabled={disabled} onClick={() => goTo(s.key)} aria-label={`Go to ${s.title}`}>
                <SideMenuItem title={s.title} subtitle={disabled ? "Save the NC first" : s.subtitle} icon={s.icon} index={i} arrLength={arr.length} disabled={disabled} />
              </button>
            );
          })}
        </nav>

        <div ref={scrollRef} className="flex h-full min-w-0 grow flex-col gap-5 overflow-y-auto bg-primary-bg p-5">
          {!isNew && ncr.deletedAt && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
              Deleted {formatDate(ncr.deletedAt)} by {ncr.deletedBy?.name ?? "—"}: “{ncr.deleteReason}”.
              {can("ncr.delete") && (
                <button type="button" onClick={restore} disabled={mutation.isPending} className={btn.neutral}>
                  <RotateCcwIcon className="h-4 w-4" /> Restore
                </button>
              )}
            </div>
          )}
          {locked && (
            <p className="px-2 text-sm text-secondary-text">
              {ncr.deletedAt ? "Deleted records are read-only." : `This non-conformance is ${stageOf(ncr.stage).label.toLowerCase()}; reopen it to make changes.`}
            </p>
          )}
          {mutation.error && !dialog && (
            <p role="alert" className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
              {describeApiError(mutation.error)}
            </p>
          )}

          <form
            id="ncr-form"
            noValidate
            aria-label="Non-conformance details"
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (canEdit && form.title.trim() && (isNew || dirty)) save(false);
            }}>
            <SectionHeading id="ncr-details" title="NC Details" sectionRef={refs.details} />
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
            <Card>
              <div className="grid w-full grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-2">
                <div className="lg:col-span-2">{text("title", "Title", { required: true, maxLength: 200, icon: FileTextIcon, placeholder: "Short summary of the problem" })}</div>
                {controlled("detectedAt", (f) => <RHFDatePickerPopout {...f} label="Detected on" required valueFormat="iso" maxDate={new Date()} />)}
                {controlled("severity", (f) => (
                  <RHFComboBox {...f} label="Severity" icon={TriangleAlertIcon} placeholder="Select severity" sort={false} hint="Needed to open" options={SEVERITIES.map((s) => ({ id: s.key, name: s.label }))} />
                ))}
                {source === "customer" && (
                  <>
                    {controlled("customerId", (f) => <PartyPicker {...f} kind="customers" label="Customer" icon={UsersIcon} current={ncr?.customer} required />)}
                    {text("customerReference", "Customer reference", { maxLength: 60, icon: HashIcon, hint: "Their complaint or claim number" })}
                  </>
                )}
                {source === "supplier" && (
                  <>
                    {controlled("supplierId", (f) => <PartyPicker {...f} kind="suppliers" label="Supplier" icon={UsersIcon} current={ncr?.supplier} required />)}
                    {text("purchaseOrder", "Purchase order", { maxLength: 60, icon: ReceiptIcon })}
                  </>
                )}
                {source !== "supplier" && text("workOrder", "Work order", { maxLength: 60, icon: BoxIcon })}
                {controlled("partId", (f) => <PartPicker {...f} icon={QrCodeIcon} current={ncr?.part} />, () => setValue("partRevisionId", null, { shouldDirty: true }))}
                {controlled("partRevisionId", (f) => <RevisionPicker {...f} icon={LayersIcon} partId={form.partId} />)}
                {text("lotNumber", "Lot / batch", { maxLength: 60, icon: HashIcon })}
                {text("serialNumber", "Serial number", { maxLength: 60, icon: HashIcon })}
                <div className="flex w-full items-start gap-5">
                  {text("quantityInspected", "Quantity inspected", { dataType: "number", icon: LayersIcon, placeholder: "Enter qty" })}
                  {text("quantityAffected", "Quantity affected", { dataType: "number", icon: LayersIcon, placeholder: "Enter qty", hint: "Needed to open" })}
                </div>
                {controlled("siteId", (f) => (
                  <RHFComboBox {...f} label="Site" icon={HouseIcon} placeholder="Select a site" options={(sites?.data ?? []).map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))} />
                ))}
                {controlled("detectionProcessId", (f) => (
                  <RHFComboBox {...f} label="Where detected" icon={FactoryIcon} placeholder="Select a process" options={opt(lists?.processes)} />
                ))}
                <div className="lg:col-span-2">
                  <RHFTextArea label="Description" icon={AlignCenterIcon} value={form.description} onChange={set("description")} disabled={!canEdit} max={5000} rows={4} placeholder="Describe the non-conformance" />
                </div>
                <RHFTextArea label="Requirement / specification" icon={ClipboardListIcon} value={form.requirement} onChange={set("requirement")} disabled={!canEdit} max={2000} rows={3} placeholder="What it should have been" />
                <RHFTextArea label="Actual result" icon={AlignCenterIcon} value={form.actualResult} onChange={set("actualResult")} disabled={!canEdit} max={2000} rows={3} placeholder="What was found" />
              </div>
            </Card>

            {!isNew && (
              <>
                <SectionHeading id="ncr-cost" title="Cost" sectionRef={refs.cost} />
                <Card>
                  <NcrCosts ncrId={ncr.id} canEdit={can("ncr.update") && !locked} />
                </Card>
              </>
            )}

            <SectionHeading id="ncr-investigation" title="Investigation" sectionRef={refs.investigation} />
            <Card>
              <div className="grid w-full grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-2">
                {controlled(
                  "failureModeId",
                  (f) => <RHFComboBox {...f} label="Failure mode" icon={TagIcon} placeholder="Select a failure mode" options={opt(lists?.failureModes)} />,
                  () => setValue("subFailureModeId", null, { shouldDirty: true })
                )}
                {controlled("subFailureModeId", (f) => (
                  <RHFComboBox {...f} label="Sub-failure mode" icon={TagsIcon} options={opt(subs)}
                    disabled={f.disabled || !form.failureModeId} placeholder={form.failureModeId ? "Select a sub-failure mode" : "Choose a failure mode first"} />
                ))}
                {controlled("causalProcessId", (f) => (
                  <RHFComboBox {...f} label="Causal process" icon={FactoryIcon} placeholder="Select a process" options={opt(lists?.processes)} />
                ))}
                {source !== "supplier" &&
                  controlled("responsibleEmployeeId", (f) => (
                    <RHFComboBox {...f} label="Responsible operator" icon={UsersIcon} placeholder="Select an operator"
                      options={(employees ?? []).filter((e) => e.active || e.id === form.responsibleEmployeeId).map((e) => ({ id: e.id, name: e.name, hint: e.jobTitle ?? undefined }))} />
                  ))}
              </div>
              <p className="text-sm text-secondary-text">Containment, root cause (8D) and corrective actions will be added here in a later release.</p>
            </Card>
          </form>

          {!isNew && (
            <>
              <SectionHeading id="ncr-info" title="Additional Information" sectionRef={refs.info} />
              <Card>
                <FileDrop ncrId={ncr.id} canEdit={can("ncr.update") && !locked} />
                <p className="pl-1 text-sm italic text-secondary-text">
                  {ncr.reference} raised by {ncr.createdBy?.name ?? "Unknown"} on{" "}
                  {new Date(ncr.createdAt).toLocaleString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  {ncr.closedAt && ` · closed ${formatDate(ncr.closedAt)} by ${ncr.closedBy?.name ?? "—"}`}
                </p>
              </Card>

              <SectionHeading id="ncr-history" title="History" sectionRef={refs.history} />
              <Card>
                <NcrHistory id={ncr.id} />
              </Card>
            </>
          )}
        </div>
      </div>

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
