import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Controller, useForm } from "react-hook-form";
import {
  AlignCenterIcon,
  ArrowLeftIcon,
  BoxIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  FactoryIcon,
  FileTextIcon,
  HashIcon,
  HistoryIcon,
  HouseIcon,
  InboxIcon,
  PencilIcon,
  LayersIcon,
  PoundSterlingIcon,
  QrCodeIcon,
  ReceiptIcon,
  RotateCcwIcon,
  SaveIcon,
  ShieldCheckIcon,
  TagIcon,
  TagsIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
  UsersIcon,
  WrenchIcon,
  BoxesIcon,
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
import { NCR_REGISTER, NC_SOURCES, SEVERITIES, SOURCE_OPTIONS, formatDate, ncrPath, sourceLabel, stageOf } from "../../lib/ncr";
import { SeverityPill, StagePill } from "./Pills";
import DeleteNcrDialog from "./DeleteNcrDialog";
import { MachinePicker, PartPicker, PartyPicker, RevisionPicker } from "./Pickers";
import ReasonDialog from "./ReasonDialog";
import ChangeSourceDialog from "./ChangeSourceDialog";
import StageBar from "./StageBar";
import NcrHistory from "./NcrHistory";
import NcrCosts from "./NcrCosts";
import NcrInspectionSource from "../inspection/NcrInspectionSource";
import NcrAuditSource from "../audits/NcrAuditSource";
import { useNcrAuditSource } from "../../hooks/useAudits";
import { useNcrInspectionSource } from "../../hooks/useInspection";
import { EMPTY, changedFields, toBody, toForm } from "./formModel";
import { useProductionSettings } from "../../hooks/useProduction";
import { LotPicker, OrderPicker, SerialPicker } from "../production/pickers";
import LinkNotices from "../production/LinkNotices";
import TraceLinks from "../production/TraceLinks";
import LoadingScreen from "../ui/LoadingScreen";
import NcrCapaCard from "../capa/NcrCapaCard";
import NcrAffectedLots from "./NcrAffectedLots";
import NcrContainment from "./NcrContainment";
import NcrDispositions from "./NcrDispositions";
import { useNcrGates } from "../../hooks/useNcr";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

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

/**
 * Create or view/edit an NCR (/Non-Conformance/Register/new?source= and /Register/:id), laid out like the
 * original NC entry form: header with Revert / Save, a side menu of sections (NC Details, Cost,
 * Investigation, Additional Info, History) and scrolling cards.
 */
const NcrPage = () => {
  const { id: routeId } = useParams();
  const isNew = routeId === "new";
  const [searchParams] = useSearchParams();
  // A new NC starts with the source chosen before the form opened; it can still be changed here until it is saved.
  const [newSource, setNewSource] = useState(() => {
    const wanted = searchParams.get("source");
    return NC_SOURCES.some((s) => s.key === wanted) ? wanted : "internal";
  });
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const { data: ncr, isLoading, error } = useNcr(isNew ? null : routeId);
  const gates = useNcrGates(isNew ? null : routeId);
  const { data: inspectionSource } = useNcrInspectionSource(isNew ? null : routeId, can("inspection.read"));
  const { data: auditSource } = useNcrAuditSource(isNew ? null : routeId, can("audits.read"));
  const { data: lists } = useClassifications();
  const { data: employees } = useEmployees();
  const { data: sites } = useSites();
  const mutation = useNcrMutation();
  const settings = useProductionSettings();
  const canLinkProduction = can("production.read");
  const { control, reset, watch, setValue } = useForm({ defaultValues: EMPTY });
  const form = watch();
  const [dialog, setDialog] = useState(null); // "cancel" | "reopen" | "delete" | "source"
  const scrollRef = useRef(null);
  const refs = { details: useRef(null), cost: useRef(null), lots: useRef(null), containment: useRef(null), investigation: useRef(null), disposition: useRef(null), info: useRef(null), history: useRef(null) };

  const source = isNew ? newSource : ncr?.source;
  const original = useMemo(() => (ncr ? toForm(ncr) : EMPTY), [ncr]);
  useEffect(() => reset(original), [original, reset]);

  const locked = !isNew && ncr && (ncr.stage === "closed" || ncr.stage === "cancelled" || !!ncr.deletedAt);
  const canEdit = isNew ? can("ncr.create") : can("ncr.update") && !locked;
  // A category can be taken off a draft, but not off a non-conformance that has been raised.
  const categoryClearable = isNew || ncr?.stage === "draft";
  const body = toBody(form, source);
  const changes = isNew ? body : changedFields(body, toBody(original, source));
  const dirty = !isNew && Object.keys(changes).length > 0;
  const set = (k) => (v) => setValue(k, v?.target ? v.target.value : v, { shouldDirty: true });
  // Picking a production record fills in what it implies (the typed text, the part when there is none, the order a lot or serial number belongs to), as the server will.
  const pickedProduction = ({ orderNumber, lotNumber, serialNumber, partId, orderId, lotId }) => {
    const put = (k, v) => v && setValue(k, v, { shouldDirty: true });
    put("workOrder", orderNumber);
    put("lotNumber", lotNumber);
    put("serialNumber", serialNumber);
    if (!form.partId) put("partId", partId);
    if (!form.productionOrderId) put("productionOrderId", orderId);
    if (!form.lotId) put("lotId", lotId);
  };

  const save = (open) => {
    if (isNew) {
      mutation.mutate(
        { path: "/ncrs", body: { source, ...body, ...(open ? { open: true } : {}) } },
        {
          onSuccess: (created) => {
            showToast({ type: "success", title: "Saved", message: `${created.reference} was ${open ? "raised" : "saved as a draft"}.` });
            navigate(ncrPath(created.id), { replace: true });
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

  if (!isNew && isLoading) return <LoadingScreen />;
  if (!isNew && error) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Link to={NCR_REGISTER} className="text-link-color hover:underline">← Register</Link>
        <Callout tone="error" role="alert">{describeApiError(error)}</Callout>
      </div>
    );
  }

  // Active categories, plus the one this NC already has if it has since been switched off.
  const categories = (lists?.categories ?? []).map((c) => ({ id: c.id, name: c.name }));
  if (ncr?.category && !categories.some((c) => c.id === ncr.category.id)) categories.push({ id: ncr.category.id, name: `${ncr.category.name} (inactive)` });
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
          onChange: (v, ...rest) => {
            field.onChange(v);
            then?.(v, ...rest);
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
    ...(settings.useLotsAndSerials ? [{ key: "lots", title: "Affected lots", subtitle: "Which lots are involved", icon: BoxesIcon, needsRecord: true }] : []),
    { key: "containment", title: "Containment", subtitle: "Stop suspect product", icon: ShieldCheckIcon, needsRecord: true },
    { key: "investigation", title: "Investigation", subtitle: "Classify the cause", icon: WrenchIcon },
    { key: "disposition", title: "Disposition", subtitle: "What happens to the items", icon: ClipboardCheckIcon, needsRecord: true },
    { key: "info", title: "Additional Info", subtitle: "Files and attachments", icon: InboxIcon, needsRecord: true },
    { key: "history", title: "History", subtitle: "Who changed what", icon: HistoryIcon, needsRecord: true },
  ];
  // Scroll only the content pane (scrollIntoView would also scroll the page around it).
  const goTo = (key) => {
    const pane = scrollRef.current;
    const el = refs[key].current;
    if (!pane || !el) return;
    const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 20;
    pane.scrollTo?.({ top: Math.max(0, top), behavior: "smooth" });
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 grow flex-col overflow-clip bg-primary-bg">
      {/* Header: back to the register, title, and the save / revert actions. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-color bg-primary-bg px-5 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3 py-2">
          <Link to={NCR_REGISTER} className="flex items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon className="h-4 w-4" /> Register
          </Link>
          <h1 className="text-xl font-semibold text-primary-text">{isNew ? "New non-conformance" : ncr.reference}</h1>
          {!isNew && <SeverityPill severity={ncr.severity} />}
          {isNew ? <span className="text-sm text-secondary-text">Not saved yet</span> : <StagePill stage={ncr.stage} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isNew && canEdit && (
            <>
              <CTAButton type="neutral" size="default" className="px-3" buttonType="submit" form="ncr-form" disabled={mutation.isPending || !form.title.trim()}>
                Save as draft
              </CTAButton>
              <CTAButton buttonType="button" onClick={() => save(true)} disabled={mutation.isPending || !form.title.trim()} type="success" size="default" className="px-3">
                <SaveIcon className="h-4 w-4" /> {mutation.isPending ? "Saving…" : "Raise NC"}
              </CTAButton>
            </>
          )}
          {!isNew && canEdit && (
            <>
              {dirty && (
                <CTAButton buttonType="button" onClick={() => reset(original)} type="neutral" size="default" className="px-3">
                  <Undo2Icon className="h-4 w-4" /> Discard changes
                </CTAButton>
              )}
              <CTAButton type="success" size="default" className="px-3" buttonType="submit" form="ncr-form" disabled={mutation.isPending || !dirty || !form.title.trim()}>
                <SaveIcon className="h-4 w-4" /> {mutation.isPending ? "Saving…" : "Save changes"}
              </CTAButton>
            </>
          )}
          {!isNew && can("ncr.delete") && !ncr.deletedAt && (
            <CTAButton buttonType="button" onClick={() => setDialog("delete")} type="danger" size="default" className="px-3">
              <Trash2Icon className="h-4 w-4" /> Delete
            </CTAButton>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-clip">
        {/* Side menu of sections, as in the original form. */}
        <nav aria-label="Sections" className="hidden h-full w-70 shrink-0 flex-col overflow-y-auto border-r border-border-color bg-primary-bg px-3 pt-4 md:flex">
          {sections.map((s, i, arr) => {
            const disabled = isNew && !!s.needsRecord;
            return (
              <button key={s.key} type="button" disabled={disabled} onClick={() => goTo(s.key)} aria-label={`Go to ${s.title}`}>
                <SideMenuItem title={s.title} subtitle={disabled ? "Save the NC first" : s.subtitle} icon={s.icon} index={i} arrLength={arr.length} disabled={disabled} />
              </button>
            );
          })}
        </nav>

        <div ref={scrollRef} className="relative flex h-full min-w-0 grow flex-col gap-5 overflow-y-auto bg-primary-bg p-5">
          {!isNew && ncr.deletedAt && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
              Deleted {formatDate(ncr.deletedAt)} by {ncr.deletedBy?.name ?? "—"}: “{ncr.deleteReason}”.
              {can("ncr.delete") && (
                <CTAButton type="neutral" size="default" className="px-3" buttonType="button" onClick={restore} disabled={mutation.isPending}>
                  <RotateCcwIcon className="h-4 w-4" /> Restore
                </CTAButton>
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
                gates={gates.data}
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
              {ncr?.links && <LinkNotices links={ncr.links} />}
              {ncr?.links && <TraceLinks links={ncr.links} />}
              <div className="grid w-full grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-2">
                <div className="lg:col-span-2">{text("title", "Title", { required: true, maxLength: 200, icon: FileTextIcon, placeholder: "Short summary of the problem" })}</div>
                {controlled("detectedAt", (f) => <RHFDatePickerPopout {...f} label="Detected on" required valueFormat="iso" maxDate={new Date()} />)}
                {controlled("severity", (f) => (
                  <RHFComboBox {...f} label="Severity" required icon={TriangleAlertIcon} placeholder="Select severity" sort={false} hint="Needed to open" options={SEVERITIES.map((s) => ({ id: s.key, name: s.label }))} />
                ))}
                {isNew ? (
                  <RHFComboBox label="Source" required icon={InboxIcon} placeholder="Select a source" sort={false} clearable={false} hint="Where it came from or was detected"
                    options={SOURCE_OPTIONS} value={newSource} onChange={(v) => v && setNewSource(v)} />
                ) : (
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-secondary-text" data-required>Source</span>
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm text-primary-text">
                      <span className="flex items-center gap-2"><InboxIcon className="h-4 w-4 text-secondary-text" /> {sourceLabel(ncr.source)}</span>
                      {can("ncr.update") && !locked && (
                        <button type="button" onClick={() => setDialog("source")} className="flex items-center gap-1 text-link-color hover:underline cursor-pointer" aria-label="Change source">
                          <PencilIcon className="h-3.5 w-3.5" /> Change
                        </button>
                      )}
                    </div>
                    {ncr.sourceChangeReason && <p className="text-xs text-secondary-text">Changed: {ncr.sourceChangeReason}</p>}
                  </div>
                )}
                {controlled("categoryId", (f) => (
                  <RHFComboBox {...f} label="Category" required icon={TagsIcon} placeholder={isNew || ncr?.stage === "draft" ? "Select a category" : "Uncategorised"} sort={false}
                    clearable={categoryClearable} hint={!form.categoryId ? "What the problem is. Needed to open" : "What the problem is"} options={categories} />
                ))}
                {source === "customer" && (
                  <>
                    {controlled("customerId", (f) => <PartyPicker {...f} kind="customers" label="Customer" icon={UsersIcon} current={ncr?.customer} required />)}
                    {text("customerReference", "Customer reference", { maxLength: 60, icon: HashIcon, hint: "Their complaint or claim number" })}
                  </>
                )}
                {(source === "supplier" || source === "goods_receiving") && (
                  <>
                    {controlled("supplierId", (f) => <PartyPicker {...f} kind="suppliers" label="Supplier" icon={UsersIcon} current={ncr?.supplier} required={source === "supplier"} hint={source === "goods_receiving" ? "If you know which supplier it came from" : undefined} />)}
                    {text("purchaseOrder", "Purchase order", { maxLength: 60, icon: ReceiptIcon })}
                  </>
                )}
                {source !== "supplier" && source !== "goods_receiving" && text("workOrder", "Work order", { maxLength: 60, icon: BoxIcon, disabled: !canEdit || !!form.productionOrderId, hint: form.productionOrderId ? "From the production order" : undefined })}
                {controlled("partId", (f) => <PartPicker {...f} icon={QrCodeIcon} current={ncr?.part} />, () => setValue("partRevisionId", null, { shouldDirty: true }))}
                {canLinkProduction && source !== "supplier" && source !== "goods_receiving" && controlled("productionOrderId", (f) => (
                  <OrderPicker {...f} partId={form.partId} current={ncr?.links?.productionOrder} label="Production order" />
                ), (id, item) => pickedProduction({ orderNumber: item?.name, partId: item?.part?.id }))}
                {controlled("partRevisionId", (f) => <RevisionPicker {...f} icon={LayersIcon} partId={form.partId} />)}
                {settings.useLotsAndSerials && canLinkProduction && controlled("lotId", (f) => (
                  <LotPicker {...f} partId={form.partId} productionOrderId={form.productionOrderId} current={ncr?.links?.lot} />
                ), (id, item) => pickedProduction({ lotNumber: item?.name, partId: item?.part?.id, orderId: item?.productionOrder?.id, orderNumber: item?.productionOrder?.orderNumber }))}
                {text("lotNumber", "Lot / batch", { maxLength: 60, icon: HashIcon, disabled: !canEdit || !!form.lotId, hint: form.lotId ? "From the lot" : undefined })}
                {settings.useLotsAndSerials && canLinkProduction && controlled("serialId", (f) => (
                  <SerialPicker {...f} partId={form.partId} lotId={form.lotId} current={ncr?.links?.serial} />
                ), (id, item) => pickedProduction({ serialNumber: item?.name, partId: item?.part?.id, lotId: item?.lot?.id, lotNumber: item?.lot?.lotNumber, orderId: item?.productionOrder?.id, orderNumber: item?.productionOrder?.orderNumber }))}
                {text("serialNumber", "Serial number", { maxLength: 60, icon: HashIcon, disabled: !canEdit || !!form.serialId, hint: form.serialId ? "From the serial number" : undefined })}
                <div className="flex w-full items-start gap-5">
                  {text("quantityInspected", "Quantity inspected", { dataType: "number", icon: LayersIcon, placeholder: "Enter qty" })}
                  {text("quantityAffected", "Quantity affected", { required: true, dataType: "number", icon: LayersIcon, placeholder: "Enter qty", hint: "Needed to open" })}
                </div>
                {controlled("siteId", (f) => (
                  <RHFComboBox {...f} label="Site" icon={HouseIcon} placeholder="Select a site" options={(sites?.data ?? []).map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))} />
                ))}
                {controlled("detectionProcessId", (f) => (
                  <MachinePicker {...f} label="Where detected" icon={FactoryIcon} current={ncr?.detectionProcess} />
                ))}
                <div className="lg:col-span-2">
                  <RHFTextArea label="Description" icon={AlignCenterIcon} value={form.description} onChange={set("description")} disabled={!canEdit} max={5000} rows={4} placeholder="Describe the non-conformance" />
                </div>
                <RHFTextArea label="Requirement / specification" icon={ClipboardListIcon} value={form.requirement} onChange={set("requirement")} disabled={!canEdit} max={2000} rows={3} placeholder="What it should have been" />
                <RHFTextArea label="Actual result" icon={AlignCenterIcon} value={form.actualResult} onChange={set("actualResult")} disabled={!canEdit} max={2000} rows={3} placeholder="What was found" />
              </div>
            </Card>

            {!isNew && inspectionSource?.inspections?.length > 0 && (
              <>
                <SectionHeading id="ncr-source" title="Source inspection" />
                <Card>
                  <NcrInspectionSource source={inspectionSource} />
                </Card>
              </>
            )}

            {!isNew && auditSource?.available && auditSource.items.length > 0 && (
              <>
                <SectionHeading id="ncr-audit-source" title="Source audit" />
                <Card>
                  <NcrAuditSource source={auditSource} />
                </Card>
              </>
            )}

            {!isNew && (
              <>
                <SectionHeading id="ncr-cost" title="Cost" sectionRef={refs.cost} />
                <Card>
                  <NcrCosts ncrId={ncr.id} siteId={ncr.site?.id} canEdit={can("ncr.update") && !locked} />
                </Card>
              </>
            )}

            {!isNew && settings.useLotsAndSerials && (
              <div onSubmit={(e) => e.stopPropagation()} className="flex flex-col gap-5">
                <SectionHeading id="ncr-lots" title="Affected lots" sectionRef={refs.lots} />
                <Card>
                  <NcrAffectedLots ncrId={ncr.id} partId={ncr.part?.id} canEdit={can("ncr.update") && !locked} />
                </Card>
              </div>
            )}

            {!isNew && (
              // Dialogs in these sections are portals whose submit events would otherwise bubble to this form.
              <div onSubmit={(e) => e.stopPropagation()} className="flex flex-col gap-5">
                <SectionHeading id="ncr-containment" title="Containment" sectionRef={refs.containment} />
                <Card>
                  <NcrContainment ncrId={ncr.id} canEdit={can("ncr.update") && !locked} />
                </Card>
              </div>
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
                  <MachinePicker {...f} label="Causal process" icon={FactoryIcon} current={ncr?.causalProcess} />
                ))}
                {source !== "supplier" &&
                  controlled("responsibleEmployeeId", (f) => (
                    <RHFComboBox {...f} label="Responsible operator" icon={UsersIcon} placeholder="Select an operator"
                      options={(employees ?? []).filter((e) => e.active || e.id === form.responsibleEmployeeId).map((e) => ({ id: e.id, name: e.name, hint: e.jobTitle ?? undefined }))} />
                  ))}
              </div>
              {!isNew && ncr && <NcrCapaCard ncr={ncr} />}
            </Card>

            {!isNew && (
              <div onSubmit={(e) => e.stopPropagation()} className="flex flex-col gap-5">
                <SectionHeading id="ncr-disposition" title="Disposition" sectionRef={refs.disposition} />
                <Card>
                  <NcrDispositions ncrId={ncr.id} canEdit={can("ncr.update") && !locked} />
                </Card>
              </div>
            )}
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
      {dialog === "source" && <ChangeSourceDialog ncr={ncr} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteNcrDialog ncr={ncr} onClose={() => setDialog(null)} onDeleted={() => navigate(NCR_REGISTER)} />}
    </div>
  );
};

export default NcrPage;
