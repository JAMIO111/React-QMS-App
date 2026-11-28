import { useState } from "react";
import { useUnits } from "../../hooks/useMasterData";
import { useTypePreview } from "../../hooks/useCalibration";
import { useDebouncedValue } from "../../hooks/useDebounce";
import { describeApiError } from "../../lib/api-client";
import { formatNumber } from "../../lib/calibration";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Field from "../ui/Field";

const isNum = (v) => v !== "" && !Number.isNaN(Number(v));
const toRange = (f) => ({
  rangeMin: isNum(f.rangeMin) ? Number(f.rangeMin) : NaN,
  rangeMax: isNum(f.rangeMax) ? Number(f.rangeMax) : NaN,
  unitCode: f.unitCode ?? null,
  resolution: isNum(f.resolution) ? Number(f.resolution) : NaN,
});

/**
 * The checks a type would give a gauge with this range, as the database works them out: the point, the limits and how each was
 * derived, or the reason one cannot be worked out. Shows only what the server answered.
 */
export const PreviewTable = ({ preview, label = "Checks worked out for this range" }) => {
  const checks = preview?.checks ?? [];
  if (!checks.length) return <p className="text-sm text-secondary-text">This type has no checks yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm" aria-label={label}>
        <thead className="text-secondary-text">
          <tr>
            <th className="px-1 py-1 font-medium">Check</th>
            <th className="px-1 py-1 text-right font-medium">Point</th>
            <th className="px-1 py-1 font-medium">Limits</th>
            <th className="px-1 py-1 font-medium">How it is worked out</th>
          </tr>
        </thead>
        <tbody className="text-primary-text">
          {checks.map((c) => (
            <tr key={c.checkId} className="border-t border-border-color align-top">
              <td className="px-1 py-1.5">{c.name}</td>
              {c.problem ? (
                <td colSpan={3} className="px-1 py-1.5 text-error-color">{c.problem}</td>
              ) : c.kind === "attribute" ? (
                <td colSpan={3} className="px-1 py-1.5 text-secondary-text">Pass / fail</td>
              ) : (
                <>
                  <td className="px-1 py-1.5 text-right">{formatNumber(c.nominal)} {c.unit}</td>
                  <td className="px-1 py-1.5">{formatNumber(c.lower)} to {formatNumber(c.upper)} {c.unit}</td>
                  <td className="px-1 py-1.5 text-secondary-text">
                    {c.followsRange ? c.derivation : "A fixed check: the same on every gauge"}
                    {c.toleranceSource && <span className="block text-xs">Source: {c.toleranceSource}</span>}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** "Try it with a range": a range typed here, the type's checks worked out for it by the database. Saves nothing. */
export const RangeTry = ({ typeId }) => {
  const units = useUnits();
  const [f, setF] = useState({ rangeMin: "0", rangeMax: "25", unitCode: "mm", resolution: "0.001" });
  const range = useDebouncedValue(toRange(f), 400);
  const preview = useTypePreview(typeId, range);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const rangeBad = isNum(f.rangeMin) && isNum(f.rangeMax) && Number(f.rangeMax) <= Number(f.rangeMin);
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border-color p-3">
      <p className="text-sm text-secondary-text">
        Type a gauge&apos;s range to see the points and limits this type&apos;s checks give it. Nothing is saved.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Range from" inputMode="decimal" value={f.rangeMin} onChange={set("rangeMin")} />
        <Field label="Range to" inputMode="decimal" value={f.rangeMax} onChange={set("rangeMax")} error={rangeBad ? "Must be above the start" : undefined} />
        <ComboField label="Unit" required value={f.unitCode} onChange={(v) => setF({ ...f, unitCode: v })} options={(units.data ?? [{ code: f.unitCode, name: f.unitCode }]).map((u) => ({ value: u.code, label: u.code, hint: u.name }))} />
        <Field label="Resolution" inputMode="decimal" value={f.resolution} onChange={set("resolution")} hint="Optional" />
      </div>
      {preview.error && <Callout tone="error" role="alert">{describeApiError(preview.error)}</Callout>}
      {preview.data && <PreviewTable preview={preview.data} />}
    </div>
  );
};
