import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import {
  useCalibrationMutation,
  useGaugeTypeCharacteristics,
  useGaugeTypes,
} from "../../hooks/useCalibration";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import { INTERVAL_UNITS, formatInterval } from "../../lib/calibration";
import MenuCard from "../ui/MenuCard";
import CharacteristicsEditor from "../calibration/CharacteristicsEditor";

const input =
  "rounded-lg border border-border-color bg-text-input-color px-2 py-1 text-sm text-primary-text focus:outline-none focus:border-brand-primary";
const button =
  "rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer";

/** Name, description and default interval of a gauge type. */
const TypeForm = ({ initial, onSubmit, onCancel, pending, submitText }) => {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [intervalValue, setIntervalValue] = useState(
    String(initial?.intervalValue ?? 12),
  );
  const [intervalUnit, setIntervalUnit] = useState(
    initial?.intervalUnit ?? "months",
  );
  const ok =
    name.trim() &&
    Number.isInteger(Number(intervalValue)) &&
    Number(intervalValue) >= 1;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok)
          onSubmit({
            name: name.trim(),
            description: description.trim() || null,
            intervalValue: Number(intervalValue),
            intervalUnit,
          });
      }}>
      <label className="flex flex-col gap-1 text-xs text-secondary-text">
        Name
        <input
          className={`${input} w-56`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="e.g. Digital caliper 0–150 mm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-secondary-text">
        Interval
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
      <button type="submit" disabled={!ok || pending} className={button}>
        {submitText}
      </button>
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
const TypeCard = ({ type, canManage }) => {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const characteristics = useGaugeTypeCharacteristics(open ? type.id : null, {
    includeInactive: showInactive,
  });
  const mutation = useCalibrationMutation();
  const { showToast } = useToast();
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
        <TypeForm
          initial={type}
          pending={mutation.isPending}
          submitText="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(body) => patch(body, `${body.name} saved.`)}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-semibold text-primary-text">
              {type.name}
              {!type.active && (
                <span className="ml-2 text-xs font-normal text-secondary-text">
                  (inactive)
                </span>
              )}
            </p>
            <p className="text-sm text-secondary-text">
              Every {formatInterval(type.intervalValue, type.intervalUnit)} ·{" "}
              {type.characteristicCount}{" "}
              {type.characteristicCount === 1
                ? "characteristic"
                : "characteristics"}{" "}
              · {type.gaugeCount} {type.gaugeCount === 1 ? "gauge" : "gauges"}
              {type.description ? ` · ${type.description}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="text-link-color hover:underline cursor-pointer">
              {open ? "Hide characteristics" : "Characteristics"}
            </button>
            {canManage && (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-link-color hover:underline cursor-pointer">
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() =>
                    patch(
                      { active: !type.active },
                      `${type.name} ${type.active ? "made inactive" : "made active"}.`,
                    )
                  }
                  className="text-link-color hover:underline cursor-pointer">
                  {type.active ? "Make inactive" : "Make active"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {open && (
        <div className="border-t border-border-color pt-3">
          <p className="mb-2 text-sm text-secondary-text">
            Copied onto each new gauge of this type. Existing gauges keep their
            own copies.
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

  return (
    <div className="flex w-full grow flex-col gap-3 pr-2">
      <h2 className="pb-2 text-2xl font-semibold text-primary-text">
        Calibration
      </h2>
      <p className="text-secondary-text">
        Gauge types set the default calibration interval and the characteristics
        checked at each calibration. A new gauge copies them; each gauge can
        then be adjusted.
        {canManage
          ? ""
          : " You can view them; a calibration manager can change them."}
      </p>
      {error && (
        <p role="alert" className="text-error-color">
          {describeApiError(error)}
        </p>
      )}
      <MenuCard
        title="Gauge types"
        subtitle="Default interval and template characteristics for each kind of gauge"
        bodyClassName="flex flex-col gap-3"
        action={
          canManage &&
          !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center gap-1 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
              <PlusIcon /> Add gauge type
            </button>
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
        {isLoading ? (
          <p className="text-secondary-text">Loading gauge types…</p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Gauge types">
            {(types ?? []).map((t) => (
              <TypeCard key={t.id} type={t} canManage={canManage} />
            ))}
            {!types?.length && (
              <li className="rounded-lg border-2 border-dashed border-border-dark-color p-4 text-center text-sm text-secondary-text">
                No gauge types yet.
              </li>
            )}
          </ul>
        )}
      </MenuCard>
    </div>
  );
};

export default SettingsCalibration;
