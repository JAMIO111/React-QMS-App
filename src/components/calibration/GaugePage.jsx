import { useEffect, useMemo, useRef, useState } from "react";
import Switch from "@/components/ui/Switch";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Controller, useForm } from "react-hook-form";
import {
  AlignCenterIcon,
  ArrowLeftIcon,
  CalendarClockIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  FactoryIcon,
  GaugeIcon,
  HashIcon,
  HistoryIcon,
  HouseIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  RulerIcon,
  SaveIcon,
  TagIcon,
  Trash2Icon,
  Undo2Icon,
  UsersIcon,
} from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useCalibrationMutation, useGauge, useGaugeCalibrations, useGaugeCharacteristics, useGaugeTypes } from "../../hooks/useCalibration";
import { useUnits } from "../../hooks/useMasterData";
import { useDepartments, usePermissions, useSites } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { GAUGE_STATUSES, INTERVAL_UNITS, describeDue, formatInterval } from "../../lib/calibration";
import { formatDate, ncrPath } from "../../lib/ncr";
import SideMenuItem from "../SideMenuItem";
import { PartyPicker } from "../ncr/Pickers";
import ReasonDialog from "../ncr/ReasonDialog";
import RHFComboBox from "../ui/RHFComboBox";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import RHFTextArea from "../ui/RHFTextArea";
import TextInput from "../ui/TextInput";
import CharacteristicsEditor from "./CharacteristicsEditor";
import GaugeHistory from "./GaugeHistory";
import PeoplePicker from "./PeoplePicker";
import { DuePill, GaugeStatusPill, OutcomePill } from "./Pills";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";

const EMPTY = {
  assetNumber: "", description: "", gaugeTypeId: null, manufacturer: "", model: "", serialNumber: "",
  siteId: null, departmentId: null, location: "", custodianId: null,
  rangeMin: "", rangeMax: "", unitCode: null, resolution: "",
  calibrationSource: "internal", supplierId: null, intervalValue: "", intervalUnit: null,
  status: "active", statusReason: "", lastCalibratedOn: null, nextDueOn: null, commissionedOn: null, notes: "",
};
const str = (v) => (v === null || v === undefined ? "" : String(v));
const toForm = (g) => ({
  assetNumber: g.assetNumber, description: g.description, gaugeTypeId: g.type?.id ?? null, manufacturer: str(g.manufacturer), model: str(g.model), serialNumber: str(g.serialNumber),
  siteId: g.site?.id ?? null, departmentId: g.department?.id ?? null, location: str(g.location), custodianId: g.custodian?.id ?? null,
  rangeMin: str(g.rangeMin), rangeMax: str(g.rangeMax), unitCode: g.unitCode ?? null, resolution: str(g.resolution),
  calibrationSource: g.calibrationSource, supplierId: g.supplier?.id ?? null, intervalValue: str(g.intervalValue), intervalUnit: g.intervalUnit,
  status: g.status, statusReason: str(g.statusReason), lastCalibratedOn: g.lastCalibratedOn, nextDueOn: g.nextDueOn, commissionedOn: g.commissionedOn, notes: str(g.notes),
});
const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
const toBody = (f) => ({
  assetNumber: f.assetNumber.trim(), description: f.description.trim(), gaugeTypeId: f.gaugeTypeId, manufacturer: f.manufacturer.trim() || null,
  model: f.model.trim() || null, serialNumber: f.serialNumber.trim() || null, siteId: f.siteId, departmentId: f.departmentId,
  location: f.location.trim() || null, custodianId: f.custodianId, rangeMin: num(f.rangeMin), rangeMax: num(f.rangeMax), unitCode: f.unitCode,
  resolution: num(f.resolution), calibrationSource: f.calibrationSource, supplierId: f.calibrationSource === "external" ? f.supplierId : null,
  intervalValue: num(f.intervalValue), intervalUnit: f.intervalValue === "" ? null : f.intervalUnit ?? "months",
  status: f.status, statusReason: f.statusReason.trim() || null, lastCalibratedOn: f.lastCalibratedOn, nextDueOn: f.nextDueOn,
  commissionedOn: f.commissionedOn, notes: f.notes.trim() || null,
});
const changed = (body, original) => Object.fromEntries(Object.entries(body).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(original[k])));
const isNum = (v) => v === "" || !Number.isNaN(Number(v));

const SectionHeading = ({ title, sectionRef }) => (
  <div ref={sectionRef} className="flex scroll-mt-5 flex-row items-center justify-start gap-3 px-2">
    <h2 className="whitespace-nowrap text-2xl text-primary-text">{title}</h2>
    <div className="h-0.5 w-full bg-border-color" />
  </div>
);
const Card = ({ children, className = "" }) => (
  <div className={`flex flex-col gap-4 rounded-2xl bg-secondary-bg p-6 shadow-lg shadow-shadow-color ${className}`}>{children}</div>
);
const SubHeading = ({ children }) => <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary-text lg:col-span-2">{children}</h3>;


/** Calibration records of a gauge, newest first. */
const CalibrationList = ({ gaugeId, canRecord }) => {
  const [showDeleted, setShowDeleted] = useState(false);
  const { data, isLoading, error } = useGaugeCalibrations(gaugeId, { deleted: showDeleted ? "include" : "exclude" });
  if (isLoading) return <LoadingScreen size="sm" />;
  if (error) return <Callout tone="error" role="alert">{describeApiError(error)}</Callout>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-secondary-text">{data.length ? `${data.length} ${data.length === 1 ? "record" : "records"}` : "No calibrations recorded yet."}</p>
        <div className="flex items-center gap-3">
          <Switch className="text-sm text-secondary-text" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)}>
            Show deleted
          </Switch>
          {canRecord && (
            <CTAButton to={`/Calibration/Gauges/${gaugeId}/calibrations/new`} type="main" size="default" className="px-3">
              <ClipboardCheckIcon className="h-4 w-4" /> Record calibration
            </CTAButton>
          )}
        </div>
      </div>
      {data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm" aria-label="Calibration history">
            <thead className="text-secondary-text">
              <tr>
                <th className="py-1 pr-2 font-medium">Reference</th>
                <th className="py-1 pr-2 font-medium">Calibrated</th>
                <th className="py-1 pr-2 font-medium">Result</th>
                <th className="py-1 pr-2 font-medium">By</th>
                <th className="py-1 pr-2 font-medium">Certificate</th>
                <th className="py-1 pr-2 font-medium">Next due</th>
                <th className="py-1 pr-2 font-medium">NC</th>
              </tr>
            </thead>
            <tbody className="text-primary-text">
              {data.map((c) => (
                <tr key={c.id} className={`border-t border-border-color ${c.deletedAt ? "opacity-60" : ""}`}>
                  <td className="py-1.5 pr-2">
                    <Link to={`/Calibration/Gauges/${gaugeId}/calibrations/${c.id}`} className="font-medium text-link-color hover:underline">{c.reference}</Link>
                    {c.deletedAt && <span className="ml-2 text-xs text-error-color">Deleted</span>}
                  </td>
                  <td className="py-1.5 pr-2">{formatDate(c.calibratedOn)}</td>
                  <td className="py-1.5 pr-2">
                    <OutcomePill outcome={c.outcome} />
                    {c.readingCount > 0 && <span className="ml-2 text-xs text-secondary-text">{c.readingCount} readings</span>}
                  </td>
                  <td className="py-1.5 pr-2">{c.performedBy === "external" ? c.supplier?.name ?? "External" : c.technician?.name ?? "In-house"}</td>
                  <td className="py-1.5 pr-2">{c.certificateNumber ?? "—"}{c.attachmentCount > 0 && <span className="ml-1 text-xs text-secondary-text">({c.attachmentCount} file{c.attachmentCount === 1 ? "" : "s"})</span>}</td>
                  <td className="py-1.5 pr-2">{formatDate(c.nextDueOn)}</td>
                  <td className="py-1.5 pr-2">{c.nonconformance ? <Link to={ncrPath(c.nonconformance.id)} className="text-link-color hover:underline">{c.nonconformance.reference}</Link> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/**
 * Add or view/edit a gauge (/Calibration/Gauges/new and /Calibration/Gauges/:id), laid out like the
 * NC page: header with Discard / Save, a side menu of sections (Details, Characteristics,
 * Calibrations, History) and scrolling cards.
 */
const GaugePage = () => {
  const { id: routeId } = useParams();
  const isNew = routeId === "new";
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { showToast } = useToast();
  const { data: gauge, isLoading, error } = useGauge(isNew ? null : routeId);
  const { data: types } = useGaugeTypes({ includeInactive: true });
  const { data: sites } = useSites();
  const units = useUnits();
  const mutation = useCalibrationMutation();
  const { control, reset, watch, setValue } = useForm({ defaultValues: EMPTY });
  const form = watch();
  const departments = useDepartments(form.siteId);
  const [showInactive, setShowInactive] = useState(false);
  const characteristics = useGaugeCharacteristics(isNew ? null : routeId, { includeInactive: showInactive });
  const [dialog, setDialog] = useState(null); // "delete"
  const scrollRef = useRef(null);
  const refs = { details: useRef(null), characteristics: useRef(null), calibrations: useRef(null), history: useRef(null) };

  const original = useMemo(() => (gauge ? toForm(gauge) : EMPTY), [gauge]);
  useEffect(() => reset(original), [original, reset]);

  const deleted = !isNew && !!gauge?.deletedAt;
  const canEdit = can("calibration.manage") && !deleted;
  const body = toBody(form);
  const changes = isNew ? Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== "")) : changed(body, toBody(original));
  const dirty = !isNew && Object.keys(changes).length > 0;
  const numbersOk = ["rangeMin", "rangeMax", "resolution", "intervalValue"].every((k) => isNum(form[k]));
  const valid = form.assetNumber.trim() && form.description.trim() && numbersOk;
  const set = (k) => (v) => setValue(k, v?.target ? v.target.value : v, { shouldDirty: true });
  const selectedType = (types ?? []).find((t) => t.id === form.gaugeTypeId);

  const save = () => {
    if (!valid) return;
    if (isNew) {
      mutation.mutate(
        { path: "/gauges", body: changes },
        {
          onSuccess: (created) => {
            showToast({ type: "success", title: "Gauge added", message: `${created.assetNumber} was added${created.type ? " with its type's characteristics" : ""}.` });
            navigate(`/Calibration/Gauges/${created.id}`, { replace: true });
          },
        }
      );
    } else {
      mutation.mutate({ path: `/gauges/${gauge.id}`, method: "PATCH", body: changes }, { onSuccess: () => showToast({ type: "success", title: "Saved", message: "Changes saved." }) });
    }
  };
  const restore = () =>
    mutation.mutate({ path: `/gauges/${gauge.id}/restore` }, { onSuccess: () => showToast({ type: "success", title: "Restored", message: `${gauge.assetNumber} is back in the register.` }) });

  if (!isNew && isLoading) return <LoadingScreen />;
  if (!isNew && error) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Link to="/Calibration/Gauges" className="text-link-color hover:underline">← Gauge register</Link>
        <Callout tone="error" role="alert">{describeApiError(error)}</Callout>
      </div>
    );
  }

  const controlled = (name, render, then) => (
    <Controller
      name={name}
      control={control}
      render={({ field }) =>
        render({
          ...field,
          onChange: (v) => {
            field.onChange(v);
            then?.(v);
          },
          disabled: !canEdit,
        })
      }
    />
  );
  const text = (name, label, props = {}) => (
    <TextInput label={label} value={form[name] ?? ""} onChange={set(name)} disabled={!canEdit} placeholder={`Enter ${label.toLowerCase()}`} {...props} />
  );
  const numberInput = (name, label, props = {}) =>
    text(name, label, { inputMode: "decimal", error: isNum(form[name]) ? undefined : "Enter a number", placeholder: "—", ...props });

  const sections = [
    { key: "details", title: "Gauge details", subtitle: "Identification, location, calibration", icon: GaugeIcon },
    { key: "characteristics", title: "Characteristics", subtitle: "What is checked at calibration", icon: RulerIcon, needsRecord: true },
    { key: "calibrations", title: "Calibrations", subtitle: "Records and certificates", icon: ClipboardCheckIcon, needsRecord: true },
    { key: "history", title: "History", subtitle: "Who changed what", icon: HistoryIcon, needsRecord: true },
  ];
  const goTo = (key) => {
    const pane = scrollRef.current;
    const el = refs[key].current;
    if (!pane || !el) return;
    pane.scrollTo?.({ top: Math.max(0, el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 20), behavior: "smooth" });
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 grow flex-col overflow-clip bg-primary-bg">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-color bg-primary-bg px-5 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3 py-2">
          <Link to="/Calibration/Gauges" className="flex items-center gap-1 text-sm text-link-color hover:underline">
            <ArrowLeftIcon className="h-4 w-4" /> Gauge register
          </Link>
          <h1 className="text-xl font-semibold text-primary-text">{isNew ? "New gauge" : `${gauge.assetNumber} · ${gauge.description}`}</h1>
          {!isNew && <GaugeStatusPill status={gauge.status} />}
          {!isNew && ["overdue", "due_soon"].includes(gauge.dueState) && <DuePill state={gauge.dueState} days={gauge.daysUntilDue} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isNew && can("calibration.record") && !deleted && (
            <CTAButton to={`/Calibration/Gauges/${gauge.id}/calibrations/new`} type="main" size="default" className="px-3">
              <ClipboardCheckIcon className="h-4 w-4" /> Record calibration
            </CTAButton>
          )}
          {canEdit && dirty && (
            <CTAButton buttonType="button" onClick={() => reset(original)} type="neutral" size="default" className="px-3">
              <Undo2Icon className="h-4 w-4" /> Discard changes
            </CTAButton>
          )}
          {canEdit && (
            <CTAButton buttonType="submit" form="gauge-form" disabled={mutation.isPending || !valid || (!isNew && !dirty)} loading={mutation.isPending} type="success" size="default" className="px-3">
              <SaveIcon className="h-4 w-4" /> {mutation.isPending ? "Saving…" : isNew ? "Add gauge" : "Save changes"}
            </CTAButton>
          )}
          {!isNew && can("calibration.manage") && !deleted && (
            <CTAButton buttonType="button" onClick={() => { mutation.reset(); setDialog("delete"); }} type="danger" size="default" className="px-3">
              <Trash2Icon className="h-4 w-4" /> Delete
            </CTAButton>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-clip">
        <nav aria-label="Sections" className="hidden h-full w-70 shrink-0 flex-col overflow-y-auto border-r border-border-color bg-primary-bg px-3 md:flex">
          <div className="mb-2 flex flex-col gap-1 border-b border-border-dark-color pb-3 pt-4 text-sm">
            {isNew ? (
              <span className="text-secondary-text">Not saved yet</span>
            ) : (
              <>
                <span className="text-secondary-text">Next due</span>
                <span className="text-lg font-semibold text-primary-text">{formatDate(gauge.nextDueOn)}</span>
                <span className="text-secondary-text">{gauge.dueState === "not_in_use" ? "Not in use" : describeDue(gauge.daysUntilDue)}</span>
                <span className="mt-1 text-secondary-text">Last result {gauge.lastOutcome ? <OutcomePill outcome={gauge.lastOutcome} /> : "—"}</span>
              </>
            )}
          </div>
          {sections.map((s, i, arr) => {
            const disabled = isNew && !!s.needsRecord;
            return (
              <button key={s.key} type="button" disabled={disabled} onClick={() => goTo(s.key)} aria-label={`Go to ${s.title}`}>
                <SideMenuItem title={s.title} subtitle={disabled ? "Add the gauge first" : s.subtitle} icon={s.icon} index={i} arrLength={arr.length} disabled={disabled} />
              </button>
            );
          })}
        </nav>

        <div ref={scrollRef} className="relative flex h-full min-w-0 grow flex-col gap-5 overflow-y-auto bg-primary-bg p-5">
          {deleted && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
              Deleted {formatDate(gauge.deletedAt)} by {gauge.deletedBy?.name ?? "—"}: “{gauge.deleteReason}”. Deleted gauges are read-only.
              {can("calibration.manage") && (
                <CTAButton buttonType="button" onClick={restore} disabled={mutation.isPending} loading={mutation.isPending} type="neutral" size="default" className="px-3">
                  <RotateCcwIcon className="h-4 w-4" /> Restore
                </CTAButton>
              )}
            </div>
          )}
          {!isNew && gauge.status === "quarantined" && (
            <p role="status" className="rounded-xl border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
              Quarantined{gauge.statusReason ? `: ${gauge.statusReason}` : ""}. Do not use this gauge until it passes calibration.
            </p>
          )}
          {mutation.error && !dialog && (
            <Callout tone="error" role="alert">{describeApiError(mutation.error)}</Callout>
          )}

          <form
            id="gauge-form"
            noValidate
            aria-label="Gauge details"
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (canEdit && valid && (isNew || dirty)) save();
            }}>
            <SectionHeading title="Gauge details" sectionRef={refs.details} />
            <Card>
              <div className="grid w-full grid-cols-1 items-start gap-x-8 gap-y-4 lg:grid-cols-2">
                <SubHeading>Identification</SubHeading>
                {text("assetNumber", "Asset number", { required: true, maxLength: 40, icon: HashIcon, placeholder: "e.g. G-0042" })}
                {text("description", "Description", { required: true, maxLength: 200, icon: GaugeIcon, placeholder: "e.g. Digital caliper 0–150 mm" })}
                {controlled("gaugeTypeId", (f) => (
                  <RHFComboBox {...f} label="Gauge type" icon={TagIcon} placeholder="Select a type"
                    hint={isNew ? "A new gauge gets the type's characteristics and interval" : undefined}
                    options={(types ?? []).filter((t) => t.active || t.id === form.gaugeTypeId).map((t) => ({ id: t.id, name: t.name, hint: `${t.code} · ${formatInterval(t.intervalValue, t.intervalUnit)}` }))} />
                ))}
                {text("manufacturer", "Manufacturer", { maxLength: 100, icon: FactoryIcon })}
                {text("model", "Model", { maxLength: 100, icon: FactoryIcon })}
                {text("serialNumber", "Serial number", { maxLength: 100, icon: HashIcon })}

                <SubHeading>Location and custody</SubHeading>
                {controlled("siteId", (f) => (
                  <RHFComboBox {...f} label="Site" icon={HouseIcon} placeholder="Select a site" options={(sites?.data ?? []).map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))} />
                ), () => setValue("departmentId", null, { shouldDirty: true }))}
                {controlled("departmentId", (f) => (
                  <RHFComboBox {...f} label="Department" icon={HouseIcon} disabled={f.disabled || !form.siteId} placeholder={form.siteId ? "Select a department" : "Choose a site first"}
                    options={(departments.data?.data ?? []).map((d) => ({ id: d.id, name: d.name, hint: d.code }))} />
                ))}
                {text("location", "Location", { maxLength: 200, icon: HouseIcon, placeholder: "e.g. Inspection room, cabinet 3" })}
                {controlled("custodianId", (f) => <PeoplePicker {...f} label="Custodian" icon={UsersIcon} placeholder="Who looks after it" current={gauge?.custodian} />)}

                <SubHeading>Measuring range</SubHeading>
                <div className="flex w-full items-start gap-4">
                  {numberInput("rangeMin", "Range from", { icon: RulerIcon })}
                  {numberInput("rangeMax", "Range to", { icon: RulerIcon })}
                </div>
                <div className="flex w-full items-start gap-4">
                  {controlled("unitCode", (f) => (
                    <RHFComboBox {...f} label="Unit" icon={RulerIcon} placeholder="Unit" sort={false} options={(units.data ?? []).map((u) => ({ id: u.code, name: u.code, hint: u.name }))} />
                  ))}
                  {numberInput("resolution", "Resolution", { icon: RulerIcon, placeholder: "e.g. 0.01" })}
                </div>

                <SubHeading>Calibration</SubHeading>
                {controlled("calibrationSource", (f) => (
                  <RHFComboBox {...f} label="Calibrated" icon={FactoryIcon} sort={false} clearable={false}
                    options={[{ id: "internal", name: "In-house" }, { id: "external", name: "External (calibration supplier)" }]} />
                ))}
                {form.calibrationSource === "external"
                  ? controlled("supplierId", (f) => <PartyPicker {...f} kind="suppliers" label="Calibration supplier" icon={UsersIcon} current={gauge?.supplier} />)
                  : <div className="hidden lg:block" />}
                <div className="flex w-full items-start gap-4">
                  {numberInput("intervalValue", "Interval", {
                    icon: RefreshCwIcon,
                    placeholder: selectedType ? `${selectedType.intervalValue} (type)` : "12",
                    hint: isNew && !form.intervalValue ? (selectedType ? `Defaults to ${formatInterval(selectedType.intervalValue, selectedType.intervalUnit)}` : "Defaults to 12 months") : undefined,
                  })}
                  {controlled("intervalUnit", (f) => (
                    <RHFComboBox {...f} value={f.value ?? (form.intervalValue ? "months" : null)} label="Unit" icon={RefreshCwIcon} placeholder="Months" sort={false} options={INTERVAL_UNITS} />
                  ))}
                </div>
                {controlled("nextDueOn", (f) => (
                  <RHFDatePickerPopout {...f} label="Next due" icon={CalendarClockIcon} valueFormat="iso" clearable hint="Set by each calibration; change it to extend or bring forward" />
                ))}
                {controlled("lastCalibratedOn", (f) => (
                  <RHFDatePickerPopout {...f} label="Last calibrated" valueFormat="iso" clearable maxDate={new Date()} hint={isNew ? "For a gauge calibrated before it was added" : "Set by calibration records"} />
                ))}
                {controlled("commissionedOn", (f) => <RHFDatePickerPopout {...f} label="Commissioned" valueFormat="iso" clearable maxDate={new Date()} />)}

                <SubHeading>Status</SubHeading>
                {controlled("status", (f) => (
                  <RHFComboBox {...f} label="Status" icon={ClipboardListIcon} sort={false} clearable={false} options={GAUGE_STATUSES.map((s) => ({ id: s.key, name: s.label }))}
                    hint="A failed calibration quarantines the gauge; passing returns it to active" />
                ))}
                {text("statusReason", "Status reason", { maxLength: 500, icon: AlignCenterIcon, placeholder: "Why (e.g. damaged anvil)" })}
                <div className="lg:col-span-2">
                  <RHFTextArea label="Notes" icon={AlignCenterIcon} value={form.notes} onChange={set("notes")} disabled={!canEdit} max={5000} rows={3} placeholder="Anything else about this gauge" />
                </div>
              </div>
            </Card>
          </form>

          {!isNew && (
            <>
              <SectionHeading title="Characteristics" sectionRef={refs.characteristics} />
              <Card>
                <p className="text-sm text-secondary-text">
                  The points checked at every calibration, each a nominal value with a tolerance either side.
                  {gauge.type ? ` Copied from ${gauge.type.name} when the gauge was added; changes here apply to this gauge only.` : ""}
                </p>
                <CharacteristicsEditor
                  items={characteristics.data}
                  isLoading={characteristics.isLoading}
                  error={characteristics.error}
                  base={`/gauges/${gauge.id}`}
                  itemBase="/gauge-characteristics"
                  canEdit={canEdit}
                  showInactive={showInactive}
                  onShowInactive={setShowInactive}
                  emptyText="No characteristics. Add the checks made at calibration, or record pass/fail results without readings."
                />
              </Card>

              <SectionHeading title="Calibrations" sectionRef={refs.calibrations} />
              <Card>
                <CalibrationList gaugeId={gauge.id} canRecord={can("calibration.record") && !deleted} />
                <p className="pl-1 text-sm italic text-secondary-text">
                  {gauge.assetNumber} added by {gauge.createdBy?.name ?? "Unknown"} on {formatDate(gauge.createdAt)}.
                </p>
              </Card>

              <SectionHeading title="History" sectionRef={refs.history} />
              <Card>
                <GaugeHistory id={gauge.id} />
              </Card>
            </>
          )}
        </div>
      </div>

      {dialog === "delete" && (
        <ReasonDialog
          title={`Delete ${gauge.assetNumber}?`}
          label="Reason for deleting (the gauge and its records are kept and can be restored)"
          confirmText="Delete"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onConfirm={(reason) =>
            mutation.mutate(
              { path: `/gauges/${gauge.id}/delete`, body: { reason } },
              {
                onSuccess: () => {
                  showToast({ type: "success", title: "Deleted", message: `${gauge.assetNumber} was deleted. It can be restored from the deleted records filter.` });
                  navigate("/Calibration/Gauges");
                },
              }
            )
          }
        />
      )}
    </div>
  );
};

export default GaugePage;
