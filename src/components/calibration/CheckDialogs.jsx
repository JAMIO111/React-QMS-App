import { useState } from "react";
import { useUnits } from "../../hooks/useMasterData";
import { CHARACTERISTIC_KINDS } from "../../lib/calibration";
import { EMPTY_CHECK, POINT_BASES, TOLERANCE_BASES, checkBody, checkProblem, evenName, evenPoints, toleranceExample } from "../../lib/rangeChecks";
import CTAButton from "@/components/CTAButton";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";

const KIND_OPTIONS = CHARACTERISTIC_KINDS.map((k) => ({ value: k.id, label: k.name, hint: k.hint }));
const POINT_OPTIONS = POINT_BASES.map((b) => ({ value: b.id, label: b.name, hint: b.hint }));
const TOLERANCE_OPTIONS = TOLERANCE_BASES.map((b) => ({ value: b.id, label: b.name, hint: b.hint }));

/** How the allowed error is given: the choice, only the boxes that choice needs, and an example sentence in the typed numbers. */
export const ToleranceFields = ({ form, setForm }) => {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const percentPoint = form.nominalBasis === "span_percent";
  const unitNote = percentPoint ? "In the gauge's own unit" : form.unitCode;
  return (
    <>
      <ComboField
        label="Tolerance"
        required
        value={form.toleranceBasis}
        onChange={(v) => setForm({ ...form, toleranceBasis: v ?? "value", ...(v !== "value" && form.tolerancePlus !== form.toleranceMinus ? { tolerancePlus: form.toleranceMinus } : {}) })}
        options={TOLERANCE_OPTIONS}
        hint={toleranceExample(form)}
      />
      {form.toleranceBasis === "value" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tolerance minus" required inputMode="decimal" value={form.toleranceMinus} onChange={set("toleranceMinus")} placeholder="0.02" hint={unitNote} />
          <Field label="Tolerance plus" required inputMode="decimal" value={form.tolerancePlus} onChange={set("tolerancePlus")} placeholder="0.02" hint={unitNote} />
        </div>
      )}
      {(form.toleranceBasis === "span_percent" || form.toleranceBasis === "reading_percent") && (
        <Field
          label={form.toleranceBasis === "span_percent" ? "Percent of the span" : "Percent of the reading"}
          required
          inputMode="decimal"
          value={form.toleranceMinus}
          onChange={(e) => setForm({ ...form, toleranceMinus: e.target.value, tolerancePlus: e.target.value })}
          placeholder="1"
          hint="The same on both sides"
        />
      )}
      {form.toleranceBasis === "value_plus_reading_percent" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fixed part" required inputMode="decimal" value={form.toleranceMinus} onChange={(e) => setForm({ ...form, toleranceMinus: e.target.value, tolerancePlus: e.target.value })} placeholder="0.003" hint={unitNote} />
          <Field label="Percent of the reading" required inputMode="decimal" value={form.toleranceReadingPercent} onChange={set("toleranceReadingPercent")} placeholder="0.01" />
        </div>
      )}
      <Field label="Where the limit comes from" value={form.toleranceSource} onChange={set("toleranceSource")} maxLength={200} placeholder="e.g. ISO 3611, the maker's datasheet" hint="Optional. Shown with the limits on every gauge and calibration record" />
    </>
  );
};

/** Add or change one check of a gauge type. Closes at once; the editor saves it and takes it back with a toast if refused. */
export const CheckDialog = ({ check, onClose, onSave }) => {
  const [form, setForm] = useState(check ?? EMPTY_CHECK);
  const units = useUnits();
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const attribute = form.kind === "attribute";
  const problem = checkProblem(form);
  const submit = (e) => {
    e.preventDefault();
    if (problem) return;
    onSave(checkBody(form));
  };
  return (
    <Dialog title={check ? `Edit ${check.name}` : "Add a check"} onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <ComboField label="Type of check" required value={form.kind} onChange={(v) => setForm({ ...form, kind: v ?? "variable" })} options={KIND_OPTIONS} />
        <Field label="Name" required value={form.name} onChange={set("name")} maxLength={120} placeholder={attribute ? "e.g. Free from damage" : "e.g. 50 % of range"} />
        {attribute ? (
          <p className="text-sm text-secondary-text">Recorded as pass or fail, with no limits.</p>
        ) : (
          <>
            <ComboField label="Where on the gauge" required value={form.nominalBasis} onChange={(v) => setForm({ ...form, nominalBasis: v ?? "value" })} options={POINT_OPTIONS} />
            {form.nominalBasis === "span_percent" ? (
              <Field
                label="Percent of the range"
                required
                inputMode="decimal"
                value={form.nominal}
                onChange={set("nominal")}
                placeholder="50"
                hint="0 is the gauge's range minimum, 100 its maximum. The point is in the gauge's own unit, so a gauge needs a range and a unit"
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nominal" required inputMode="decimal" value={form.nominal} onChange={set("nominal")} placeholder="25" />
                <ComboField
                  label="Unit"
                  required
                  value={form.unitCode}
                  onChange={(v) => setForm({ ...form, unitCode: v })}
                  options={(units.data ?? [{ code: form.unitCode, name: form.unitCode }]).map((u) => ({ value: u.code, label: u.code, hint: u.name }))}
                />
              </div>
            )}
            <ToleranceFields form={form} setForm={setForm} />
          </>
        )}
        <Field label="Method" value={form.method} onChange={set("method")} maxLength={500} placeholder="Optional" />
        {problem && form.name.trim() && <p className="text-sm text-secondary-text" role="status">{problem}.</p>}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!!problem}>{check ? "Save" : "Add check"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * "Add evenly spaced points": several checks at percentages of the range in one go (for example 5 points from 0 to 100 %), all with the
 * same tolerance. `onAdd(bodies)` makes them one after another.
 */
export const EvenPointsDialog = ({ onClose, onAdd, pending }) => {
  const [count, setCount] = useState("5");
  const [from, setFrom] = useState("0");
  const [to, setTo] = useState("100");
  const [form, setForm] = useState({ ...EMPTY_CHECK, nominalBasis: "span_percent", nominal: "0", toleranceBasis: "reading_percent", toleranceMinus: "1", tolerancePlus: "1" });
  const nums = [count, from, to].every((v) => v !== "" && !Number.isNaN(Number(v)));
  const countOk = nums && Number(count) >= 2 && Number(count) <= 21 && Number.isInteger(Number(count));
  const rangeOk = nums && Number(from) >= 0 && Number(to) <= 100 && Number(from) < Number(to);
  const points = countOk && rangeOk ? evenPoints(count, from, to) : [];
  // Judge the tolerance with a stand-in point and name so only the tolerance can be what is wrong.
  const tolProblem = checkProblem({ ...form, name: "x", nominal: "50" });
  const ok = points.length > 0 && !tolProblem;
  const submit = (e) => {
    e.preventDefault();
    if (!ok) return;
    onAdd(points.map((p) => checkBody({ ...form, name: evenName(p), nominal: String(p) })));
  };
  return (
    <Dialog title="Add evenly spaced points" onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Makes one check for each point, each a percentage of the gauge&apos;s range, all with the tolerance below.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="How many points" required inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} error={nums && !countOk ? "2 to 21" : undefined} />
          <Field label="From (% of range)" required inputMode="decimal" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Field label="To (% of range)" required inputMode="decimal" value={to} onChange={(e) => setTo(e.target.value)} error={nums && !rangeOk ? "Between 0 and 100, above the start" : undefined} />
        </div>
        <ToleranceFields form={form} setForm={setForm} />
        <p className="text-sm text-secondary-text" aria-live="polite">
          {points.length ? `Will add: ${points.map(evenName).join(", ")}.` : "Choose how many points and where they start and end."}
        </p>
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ok || pending} loading={pending} loadingText="Adding…">
            Add {points.length || ""} checks
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};
