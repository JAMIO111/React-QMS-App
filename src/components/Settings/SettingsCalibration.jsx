import { useState } from "react";
import { ChevronDownIcon, PencilIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import {
  useCalibrationMutation,
  useGaugeTypeCharacteristics,
  useGaugeTypes,
} from "../../hooks/useCalibration";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { INTERVAL_UNITS, formatInterval, gaugeTypeCodeFromName } from "../../lib/calibration";
import { Link } from "react-router-dom";
import { documentPath } from "../../lib/documents";
import ProcedureDocumentPicker from "../calibration/ProcedureDocumentPicker";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import Switch from "../ui/Switch";
import StatTile from "../ui/StatTile";
import CharacteristicsEditor from "../calibration/CharacteristicsEditor";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import CustomFieldsCard, { CustomFieldInputs } from "../custom-fields/CustomFieldsCard";
import { withCustomValues } from "../../lib/customFields";

const input =
  "rounded-lg border border-border-color bg-text-input-color px-3 min-h-9.5 py-1.5 text-sm text-primary-text focus:outline-none focus:border-brand-primary";

/** Code, name, description and default interval of a gauge type. A new type's code is suggested from its name until it is typed. */
const TypeForm = ({ initial, onSubmit, onCancel, pending, submitText }) => {
  const [name, setName] = useState(initial?.name ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [codeTouched, setCodeTouched] = useState(!!initial);
  const shownCode = codeTouched ? code : gaugeTypeCodeFromName(name);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [procedureDocumentId, setProcedureDocumentId] = useState(initial?.procedureDocumentId ?? null);
  const [intervalValue, setIntervalValue] = useState(
    String(initial?.intervalValue ?? 12),
  );
  const [intervalUnit, setIntervalUnit] = useState(
    initial?.intervalUnit ?? "months",
  );
  const [customValues, setCustomValues] = useState({});
  const ok =
    name.trim() &&
    shownCode.trim() &&
    Number.isInteger(Number(intervalValue)) &&
    Number(intervalValue) >= 1;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok)
          onSubmit({
            code: shownCode.trim(),
            name: name.trim(),
            description: description.trim() || null,
            procedureDocumentId: procedureDocumentId ?? null,
            intervalValue: Number(intervalValue),
            intervalUnit,
            ...(initial ? {} : withCustomValues(customValues)),
          });
      }}>
      <label className="flex flex-col gap-1 text-xs text-secondary-text">
        <span data-required>Code</span>
        <input
          className={`${input} w-40 font-mono uppercase`}
          value={shownCode}
          onChange={(e) => {
            setCodeTouched(true);
            setCode(e.target.value.toUpperCase());
          }}
          maxLength={40}
          placeholder="e.g. CAL-150"
          title="Identifies the gauge type in Fortress and in imports; unique"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-secondary-text">
        <span data-required>Name</span>
        <input
          className={`${input} w-56`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="e.g. Digital caliper 0–150 mm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-secondary-text">
        <span data-required>Interval</span>
        <span className="flex gap-1">
          <input
            aria-label="Interval"
            className={`${input} w-16 text-right`}
            inputMode="numeric"
            value={intervalValue}
            onChange={(e) => setIntervalValue(e.target.value)}
          />
          <select
            aria-label="Interval unit"
            className={input}
            value={intervalUnit}
            onChange={(e) => setIntervalUnit(e.target.value)}>
            {INTERVAL_UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name.toLowerCase()}
              </option>
            ))}
          </select>
        </span>
      </label>
      <div className="w-72" title="The controlled document gauges of this type are calibrated to; a new calibration starts with its number">
        <ProcedureDocumentPicker value={procedureDocumentId} onChange={(id) => setProcedureDocumentId(id ?? null)} current={initial?.procedureDocument} />
      </div>
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-secondary-text">
        Description
        <input
          className={input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1000}
          placeholder="Optional"
        />
      </label>
      {!initial && (
        <div className="basis-full">
          <CustomFieldInputs entityType="gauge_type" values={customValues} onChange={setCustomValues} />
        </div>
      )}
      <CTAButton type="main" size="md" buttonType="submit" disabled={!ok || pending} loading={pending}>
        {submitText}
      </CTAButton>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-secondary-text hover:underline cursor-pointer">
          Cancel
        </button>
      )}
    </form>
  );
};

/** One gauge type: summary, edit, switch off, and its template characteristics. */
/** What applying a type's checks did, in words. */
export const appliedMessage = (r) => {
  if (!r || r.characteristicsAdded === 0) return "Every gauge already had these checks.";
  const gauges = `${r.gaugesUpdated} ${r.gaugesUpdated === 1 ? "gauge" : "gauges"}`;
  const checks = `${r.characteristicsAdded} ${r.characteristicsAdded === 1 ? "check" : "checks"}`;
  const skipped = r.gaugesSkipped
    ? ` ${r.gaugesSkipped} ${r.gaugesSkipped === 1 ? "gauge was" : "gauges were"} left: at a site where you do not manage calibration.`
    : "";
  return `${checks} added to ${gauges}.${skipped}`;
};

const TypeCard = ({ type, canManage }) => {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const characteristics = useGaugeTypeCharacteristics(open ? type.id : null, {
    includeInactive: showInactive,
  });
  const mutation = useCalibrationMutation();
  const apply = useCalibrationMutation();
  const { showToast } = useToast();
  const applyChecks = () =>
    apply.mutate(
      { path: `/gauge-types/${type.id}/apply-characteristics`, method: "POST" },
      {
        onSuccess: (r) => showToast({ type: "success", title: "Checks applied", message: appliedMessage(r) }),
        onError: (err) => showToast({ type: "error", title: "Not applied", message: describeApiError(err) }),
      },
    );
  const missing = type.active && type.characteristicCount > 0 ? (type.gaugesMissingChecks ?? 0) : 0;
  const patch = (body, message) =>
    mutation.mutate(
      { path: `/gauge-types/${type.id}`, method: "PATCH", body },
      {
        onSuccess: () => {
          setEditing(false);
          showToast({ type: "success", title: "Saved", message });
        },
        onError: (err) =>
          showToast({
            type: "error",
            title: "Not saved",
            message: describeApiError(err),
          }),
      },
    );

  return (
    <li
      className={`flex flex-col gap-3 rounded-xl border border-border-color bg-primary-bg p-4 ${type.active ? "" : "opacity-70"}`}>
      {editing ? (
        <>
          <TypeForm
            initial={type}
            pending={mutation.isPending}
            submitText="Save"
            onCancel={() => setEditing(false)}
            onSubmit={(body) => patch(body, `${body.name} saved.`)}
          />
          <CustomFieldsCard entityType="gauge_type" record={type} editable={canManage} />
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 font-semibold text-primary-text">
              <span className="rounded-md bg-border-color/60 px-1.5 py-0.5 font-mono text-xs font-medium text-secondary-text" title="Code">{type.code}</span>
              {type.name}
              <span className="rounded-full border border-border-color px-2 py-0.5 text-xs font-normal text-secondary-text">
                Every {formatInterval(type.intervalValue, type.intervalUnit)}
              </span>
              {!type.active && (
                <span className="rounded-full bg-border-color/60 px-2 py-0.5 text-xs font-normal text-secondary-text">
                  Inactive
                </span>
              )}
            </p>
            <p className="text-sm pt-2 text-secondary-text">
              {type.characteristicCount}{" "}
              {type.characteristicCount === 1
                ? "characteristic"
                : "characteristics"}{" "}
              · {type.gaugeCount} {type.gaugeCount === 1 ? "gauge" : "gauges"}
              {type.procedureDocument && (
                <>
                  {" · Procedure "}
                  <Link to={documentPath(type.procedureDocument.id)} className="text-link-color hover:underline">
                    {type.procedureDocument.number}
                  </Link>
                </>
              )}
              {!type.procedureDocument && type.procedureDocumentId ? " · Procedure: a document you may not read" : ""}
              {type.description ? ` · ${type.description}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-1 min-h-9.5 rounded-lg border border-border-color px-2.5 py-1 text-sm text-primary-text hover:border-border-dark-color cursor-pointer">
              {open ? "Hide characteristics" : "Characteristics"}
              <ChevronDownIcon
                className={`transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
            {canManage && (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  aria-label={`Edit ${type.name}`}
                  title="Edit"
                  className="rounded-md p-1.5 text-secondary-text hover:bg-border-color/60 hover:text-primary-text cursor-pointer">
                  <PencilIcon />
                </button>
                <Switch
                  checked={type.active}
                  aria-label={`${type.name} active`}
                  title={
                    type.active
                      ? "Active: tap to make inactive"
                      : "Inactive: tap to make active"
                  }
                  onChange={(e) =>
                    patch(
                      { active: e.target.checked },
                      `${type.name} ${e.target.checked ? "made active" : "made inactive"}.`,
                    )
                  }
                />
              </>
            )}
          </div>
        </div>
      )}
      {!editing && missing > 0 && (
        <Callout
          tone="warning"
          title={`${missing} ${missing === 1 ? "gauge is" : "gauges are"} missing some of these checks`}
          action={
            canManage && (
              <CTAButton type="main" size="md" onClick={applyChecks} loading={apply.isPending} loadingText="Applying…">
                Apply the checks to {missing === 1 ? "it" : "them"}
              </CTAButton>
            )
          }>
          A gauge gets its type&apos;s checks when it is created, so gauges made or imported before a check was added do not have it.
          {canManage
            ? " Applying adds only the checks a gauge does not have; nothing already on a gauge changes."
            : " Someone who manages calibration can apply them."}
        </Callout>
      )}
      {open && (
        <div className="border-t border-border-color pt-3">
          <p className="mb-2 text-sm text-secondary-text">
            Copied onto each new gauge of this type. Gauges made before a check
            was added get it when you apply the checks; each gauge keeps its own
            copies.
          </p>
          <CharacteristicsEditor
            items={characteristics.data}
            isLoading={characteristics.isLoading}
            error={characteristics.error}
            base={`/gauge-types/${type.id}`}
            itemBase="/gauge-type-characteristics"
            canEdit={canManage}
            showInactive={showInactive}
            onShowInactive={setShowInactive}
            emptyText="No template characteristics yet."
          />
        </div>
      )}
    </li>
  );
};

/** Settings → Calibration: gauge types, their default interval and template characteristics. */
const SettingsCalibration = () => {
  const { can } = usePermissions();
  const canManage = can("calibration.manage");
  const {
    data: types,
    isLoading,
    error,
  } = useGaugeTypes({ includeInactive: true });
  const mutation = useCalibrationMutation();
  const { showToast } = useToast();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = (types ?? []).filter(
    (t) => !q || [t.code, t.name, t.description].some((v) => v?.toLowerCase().includes(q)),
  );

  return (
    <div className="flex w-full flex-col gap-4">
      {error && (
        <p role="alert" className="text-error-color">
          {describeApiError(error)}
        </p>
      )}
      {types && (
        <div className="flex flex-wrap gap-3">
          <StatTile
            label="Gauge types"
            value={types.filter((t) => t.active).length}
            note={
              types.some((t) => !t.active)
                ? `${types.filter((t) => !t.active).length} inactive`
                : "all active"
            }
          />
          <StatTile
            label="Gauges"
            value={types.reduce((n, t) => n + (t.gaugeCount ?? 0), 0)}
            note="Across all types"
          />
          <StatTile
            label="Template characteristics"
            value={types.reduce((n, t) => n + (t.characteristicCount ?? 0), 0)}
            note="Copied onto new gauges"
          />
        </div>
      )}
      <MenuCard
        title="Gauge types"
        subtitle="Default interval and template characteristics for each kind of gauge"
        bodyClassName="flex flex-col gap-3"
        action={
          canManage &&
          !adding && (
            <CTAButton
              buttonType="button"
              onClick={() => setAdding(true)}
              type="neutral" size="md" className="flex items-center gap-1 px-3 py-1">
              <PlusIcon /> Add gauge type
            </CTAButton>
          )
        }>
        {canManage && adding && (
          <div className="rounded-xl border border-border-color bg-primary-bg p-4">
            <TypeForm
              pending={mutation.isPending}
              submitText="Add type"
              onCancel={() => setAdding(false)}
              onSubmit={(body) =>
                mutation.mutate(
                  { path: "/gauge-types", body },
                  {
                    onSuccess: (t) => {
                      setAdding(false);
                      showToast({
                        type: "success",
                        title: "Added",
                        message: `${t.name} added. Open its characteristics to add the checks.`,
                      });
                    },
                    onError: (err) =>
                      showToast({
                        type: "error",
                        title: "Not added",
                        message: describeApiError(err),
                      }),
                  },
                )
              }
            />
          </div>
        )}
        {!!types?.length && (
          <label className="relative self-start">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary-text" />
            <input
              type="search"
              aria-label="Search gauge types"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search code, name or description…"
              className="w-72 max-w-full rounded-lg border border-border-color bg-text-input-color min-h-9.5 py-1.5 pl-8 pr-3 text-sm text-primary-text placeholder:text-tertiary-text focus:border-brand-primary focus:outline-none"
            />
          </label>
        )}
        {isLoading ? (
          <LoadingScreen size="sm" />
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Gauge types">
            {shown.map((t) => (
              <TypeCard key={t.id} type={t} canManage={canManage} />
            ))}
            {!types?.length && (
              <li className="rounded-lg border-2 border-dashed border-border-dark-color p-4 text-center text-sm text-secondary-text">
                No gauge types yet.
              </li>
            )}
            {!!types?.length && !shown.length && (
              <li className="rounded-lg border-2 border-dashed border-border-dark-color p-4 text-center text-sm text-secondary-text">
                No gauge type matches “{query.trim()}”.
              </li>
            )}
          </ul>
        )}
      </MenuCard>
    </div>
  );
};

export default SettingsCalibration;
