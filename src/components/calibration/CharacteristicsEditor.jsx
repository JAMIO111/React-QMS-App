import { useState } from "react";
import Switch from "@/components/ui/Switch";
import { ChevronDownIcon, ChevronUpIcon, PencilIcon, PlusIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useCalibrationMutation } from "../../hooks/useCalibration";
import { useUnits } from "../../hooks/useMasterData";
import { describeApiError } from "../../lib/api-client";
import { CHARACTERISTIC_KINDS, formatNumber, formatTolerance } from "../../lib/calibration";

const input = "w-full rounded-lg border border-border-color bg-text-input-color px-2 py-1 text-sm text-primary-text focus:outline-none focus:border-brand-primary disabled:opacity-60";
const EMPTY = { kind: "variable", name: "", nominal: "", toleranceMinus: "", tolerancePlus: "", unitCode: "mm", method: "" };
const str = (v) => (v === null || v === undefined ? "" : String(v));
const toForm = (c) => ({
  kind: c.kind ?? "variable",
  name: c.name,
  nominal: str(c.nominal),
  toleranceMinus: str(c.toleranceMinus),
  tolerancePlus: str(c.tolerancePlus),
  unitCode: c.unitCode ?? "mm",
  method: c.method ?? "",
});
const isNumber = (v) => v !== "" && !Number.isNaN(Number(v));
const valid = (f) =>
  f.name.trim() &&
  (f.kind === "attribute" ||
    (isNumber(f.nominal) && isNumber(f.toleranceMinus) && Number(f.toleranceMinus) >= 0 && isNumber(f.tolerancePlus) && Number(f.tolerancePlus) >= 0 && f.unitCode));
const toBody = (f) =>
  f.kind === "attribute"
    ? { kind: "attribute", name: f.name.trim(), method: f.method.trim() || null }
    : {
        kind: "variable",
        name: f.name.trim(),
        nominal: Number(f.nominal),
        toleranceMinus: Number(f.toleranceMinus),
        tolerancePlus: Number(f.tolerancePlus),
        unitCode: f.unitCode,
        method: f.method.trim() || null,
      };

/** Name, nominal, tolerances, unit and method, as one row of inputs. */
const Fields = ({ form, setForm, units, idPrefix }) => {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const attribute = form.kind === "attribute";
  return (
    <>
      <td className="p-1">
        <select aria-label="Type of check" className={input} value={form.kind} onChange={set("kind")}>
          {CHARACTERISTIC_KINDS.map((k) => (
            <option key={k.id} value={k.id} title={k.hint}>{k.name}</option>
          ))}
        </select>
      </td>
      <td className="p-1"><input aria-label="Characteristic" className={input} value={form.name} onChange={set("name")} maxLength={120} placeholder={attribute ? "e.g. Free from damage" : "e.g. 25 mm gauge block"} id={`${idPrefix}-name`} /></td>
      {attribute ? (
        <td colSpan={4} className="p-1 text-xs text-secondary-text">Recorded as pass or fail — no limits</td>
      ) : (
        <>
          <td className="p-1"><input aria-label="Nominal" className={`${input} text-right`} inputMode="decimal" value={form.nominal} onChange={set("nominal")} placeholder="25" /></td>
          <td className="p-1"><input aria-label="Tolerance minus" className={`${input} text-right`} inputMode="decimal" value={form.toleranceMinus} onChange={set("toleranceMinus")} placeholder="0.02" /></td>
          <td className="p-1"><input aria-label="Tolerance plus" className={`${input} text-right`} inputMode="decimal" value={form.tolerancePlus} onChange={set("tolerancePlus")} placeholder="0.02" /></td>
          <td className="p-1">
            <select aria-label="Unit" className={input} value={form.unitCode} onChange={set("unitCode")}>
              {(units ?? [{ code: form.unitCode, name: form.unitCode }]).map((u) => (
                <option key={u.code} value={u.code}>{u.code}</option>
              ))}
            </select>
          </td>
        </>
      )}
      <td className="p-1"><input aria-label="Method" className={input} value={form.method} onChange={set("method")} maxLength={500} placeholder="Optional" /></td>
    </>
  );
};

/**
 * Calibration characteristics of a gauge or of a gauge type (template): each a nominal value with a
 * tolerance either side. `base` is "/gauges/{id}" or "/gauge-types/{id}" (list and create);
 * `itemBase` is "/gauge-characteristics" or "/gauge-type-characteristics" (update). Characteristics
 * are never removed — switch them off so past readings keep their meaning.
 */
const CharacteristicsEditor = ({ items = [], isLoading, error, base, itemBase, canEdit, emptyText, showInactive, onShowInactive }) => {
  const units = useUnits();
  const mutation = useCalibrationMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(null); // characteristic id
  const [editForm, setEditForm] = useState(EMPTY);
  const [adding, setAdding] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY);
  const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder);

  const fail = (title) => (err) => showToast({ type: "error", title, message: describeApiError(err) });
  const patch = (id, body, onSuccess) => mutation.mutate({ path: `${itemBase}/${id}`, method: "PATCH", body }, { onSuccess, onError: fail("Not saved") });
  /** Swap places with the neighbour: both get distinct sort orders. */
  const move = (index, delta) => {
    const a = ordered[index];
    const b = ordered[index + delta];
    if (!a || !b) return;
    const [ao, bo] = a.sortOrder === b.sortOrder ? [index + delta + 1, index + 1] : [b.sortOrder, a.sortOrder];
    patch(a.id, { sortOrder: ao }, () => patch(b.id, { sortOrder: bo }));
  };
  const create = () =>
    mutation.mutate(
      { path: `${base}/characteristics`, body: toBody(newForm) },
      {
        onSuccess: (c) => {
          setNewForm({ ...EMPTY, unitCode: newForm.unitCode });
          setAdding(false);
          showToast({ type: "success", title: "Added", message: `${c.name} added.` });
        },
        onError: fail("Not added"),
      }
    );

  if (isLoading) return <p className="text-secondary-text">Loading characteristics…</p>;
  if (error) return <p role="alert" className="text-error-color">{describeApiError(error)}</p>;

  return (
    <div className="flex flex-col gap-3">
      {onShowInactive && (
        <Switch className="self-end text-sm text-secondary-text" checked={!!showInactive} onChange={(e) => onShowInactive(e.target.checked)}>
          Show switched-off
        </Switch>
      )}
      {ordered.length === 0 && !adding ? (
        <p className="rounded-lg border-2 border-dashed border-border-dark-color p-4 text-center text-sm text-secondary-text">{emptyText ?? "No characteristics yet."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] text-left text-sm" aria-label="Calibration characteristics">
            <thead className="text-secondary-text">
              <tr>
                <th className="w-[12%] px-1 py-1 font-medium">Type</th>
                <th className="w-[24%] px-1 py-1 font-medium">Characteristic</th>
                <th className="w-[11%] px-1 py-1 text-right font-medium">Nominal</th>
                <th className="w-[10%] px-1 py-1 text-right font-medium">Tol −</th>
                <th className="w-[10%] px-1 py-1 text-right font-medium">Tol +</th>
                <th className="w-[9%] px-1 py-1 font-medium">Unit</th>
                <th className="px-1 py-1 font-medium">Method</th>
                {canEdit && <th className="w-48 px-1 py-1"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="text-primary-text">
              {ordered.map((c, i) =>
                editing === c.id ? (
                  <tr key={c.id} className="border-t border-border-color">
                    <Fields form={editForm} setForm={setEditForm} units={units.data} idPrefix={c.id} />
                    <td className="p-1">
                      <div className="flex gap-1">
                        <button type="button" disabled={!valid(editForm) || mutation.isPending} onClick={() => patch(c.id, toBody(editForm), () => setEditing(null))}
                          className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-2 py-1 text-sm disabled:opacity-50 cursor-pointer">Save</button>
                        <button type="button" onClick={() => setEditing(null)} className="px-1 text-sm text-secondary-text hover:underline cursor-pointer">Cancel</button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id} className={`border-t border-border-color ${c.active ? "" : "opacity-60"}`}>
                    <td className="px-1 py-1.5">
                      <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${c.kind === "attribute" ? "bg-theme/15 text-theme" : "bg-border-color text-primary-text"}`}>
                        {c.kind === "attribute" ? "Pass / fail" : "Measured"}
                      </span>
                    </td>
                    <td className="px-1 py-1.5">
                      {c.name}
                      {!c.active && <span className="ml-2 text-xs text-secondary-text">(switched off)</span>}
                      {c.kind !== "attribute" && <span className="block text-xs text-secondary-text">{formatNumber(c.lower)} to {formatNumber(c.upper)} {c.unitCode}</span>}
                    </td>
                    {c.kind === "attribute" ? (
                      <td colSpan={4} className="px-1 py-1.5 text-secondary-text">—</td>
                    ) : (
                      <>
                        <td className="px-1 py-1.5 text-right">{formatNumber(c.nominal)}</td>
                        <td className="px-1 py-1.5 text-right">{formatNumber(c.toleranceMinus)}</td>
                        <td className="px-1 py-1.5 text-right">{formatNumber(c.tolerancePlus)}</td>
                        <td className="px-1 py-1.5">{c.unitCode}</td>
                      </>
                    )}
                    <td className="px-1 py-1.5 text-secondary-text">{c.method ?? "—"}</td>
                    {canEdit && (
                      <td className="px-1 py-1.5">
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" aria-label={`Move ${c.name} up`} disabled={i === 0 || mutation.isPending} onClick={() => move(i, -1)} className="rounded p-1 hover:bg-border-color/50 disabled:opacity-30 cursor-pointer">
                            <ChevronUpIcon />
                          </button>
                          <button type="button" aria-label={`Move ${c.name} down`} disabled={i === ordered.length - 1 || mutation.isPending} onClick={() => move(i, 1)} className="rounded p-1 hover:bg-border-color/50 disabled:opacity-30 cursor-pointer">
                            <ChevronDownIcon />
                          </button>
                          <button type="button" aria-label={`Edit ${c.name}`} onClick={() => { setEditing(c.id); setEditForm(toForm(c)); }} className="rounded p-1 hover:bg-border-color/50 cursor-pointer">
                            <PencilIcon />
                          </button>
                          <button type="button" disabled={mutation.isPending} onClick={() => patch(c.id, { active: !c.active })} className="whitespace-nowrap rounded px-1 text-xs text-link-color hover:underline disabled:opacity-50 cursor-pointer" title={formatTolerance(c)}>
                            {c.active ? "Switch off" : "Switch on"}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                )
              )}
              {adding && (
                <tr className="border-t border-border-color">
                  <Fields form={newForm} setForm={setNewForm} units={units.data} idPrefix="new" />
                  <td className="p-1">
                    <div className="flex gap-1">
                      <button type="button" disabled={!valid(newForm) || mutation.isPending} onClick={create}
                        className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-2 py-1 text-sm disabled:opacity-50 cursor-pointer">Add</button>
                      <button type="button" onClick={() => setAdding(false)} className="px-1 text-sm text-secondary-text hover:underline cursor-pointer">Cancel</button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && !adding && (
        <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 self-start rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
          <PlusIcon /> Add characteristic
        </button>
      )}
    </div>
  );
};

export default CharacteristicsEditor;
