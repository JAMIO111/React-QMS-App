import { useMemo, useState } from "react";
import { PencilIcon, PlusIcon, SearchIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useCharacteristicTemplates, useProcessControlMutation } from "../../hooks/useProcessControl";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import MenuCard from "../ui/MenuCard";
import Dialog from "../ui/Dialog";
import Switch from "../ui/Switch";
import StatTile from "../ui/StatTile";
import CharacteristicForm from "../process-control/CharacteristicForm";
import LoadingScreen from "../ui/LoadingScreen";

const inputClass =
  "rounded-lg border border-border-color bg-text-input-color px-3 py-1.5 text-sm text-primary-text placeholder:text-tertiary-text focus:outline-none focus:border-brand-primary";

const describe = (t) => {
  if (t.dataType === "attribute") return "Pass / fail";
  if (t.dataType === "count") return t.upperLimit !== null && t.upperLimit !== undefined ? `Defects, at most ${t.upperLimit} per unit` : "Defects counted";
  if (t.valueSource === "part_spec") return `Part-specific (${t.specKey ?? "—"})${t.unitCode ? ` · ${t.unitCode}` : ""}`;
  return `${t.nominal ?? "—"} (${t.lowerLimit ?? "—"} to ${t.upperLimit ?? "—"})${t.unitCode ? ` ${t.unitCode}` : ""}`;
};

const kindOf = (t) => (t.dataType === "attribute" ? "Attribute" : t.dataType === "count" ? "Count" : t.valueSource === "part_spec" ? "Part spec" : "Variable");

/** Settings → Process control: reusable characteristics picked from a dropdown on a control plan revision. */
const SettingsProcessControl = () => {
  const { can } = usePermissions();
  const canManage = can("process_control.manage");
  const [showInactive, setShowInactive] = useState(true);
  const [query, setQuery] = useState("");
  // Always load everything so the counts are right; the switch only filters what is shown.
  const { data: templates, isLoading, error } = useCharacteristicTemplates({ includeInactive: true });
  const mutation = useProcessControlMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(null);

  const toggleActive = (t, active) =>
    mutation.mutate(
      { path: `/characteristic-templates/${t.id}`, method: "PATCH", body: { active } },
      {
        onSuccess: () => showToast({ type: "success", title: "Saved", message: `${t.name} ${active ? "made active" : "made inactive"}.` }),
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      },
    );

  const counts = useMemo(() => {
    const all = templates ?? [];
    return {
      total: all.length,
      inactive: all.filter((t) => !t.active).length,
      variable: all.filter((t) => kindOf(t) === "Variable").length,
      attribute: all.filter((t) => kindOf(t) === "Attribute").length,
      count: all.filter((t) => kindOf(t) === "Count").length,
      spec: all.filter((t) => kindOf(t) === "Part spec").length,
    };
  }, [templates]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (templates ?? []).filter(
      (t) => (showInactive || t.active) && (!q || `${t.name} ${t.characteristicKey} ${t.description ?? ""}`.toLowerCase().includes(q)),
    );
  }, [templates, query, showInactive]);

  return (
    <div className="flex w-full grow flex-col gap-4 p-4 pr-2">
      <div>
        <h2 className="text-2xl font-semibold text-primary-text">Process control</h2>
        <p className="text-sm text-secondary-text">
          Characteristic templates are reusable checks (for example an outer diameter) that you choose from a dropdown when adding a characteristic to a draft control plan revision. Choosing one copies its
          values, so later changes here never alter existing plans.
          {canManage ? "" : " You can view them; a process control manager can change them."}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-error-color">
          {describeApiError(error)}
        </p>
      )}
      {templates && (
        <div className="flex flex-wrap gap-3">
          <StatTile label="Templates" value={counts.total - counts.inactive} note={counts.inactive ? `${counts.inactive} inactive` : "all active"} />
          <StatTile label="Variable" value={counts.variable} note="Measured, with limits" />
          <StatTile label="Attribute" value={counts.attribute} note="Pass / fail" />
          <StatTile label="Count" value={counts.count} note="Defects per unit" />
          <StatTile label="Part-specific" value={counts.spec} note="Limits from the part" />
        </div>
      )}
      <MenuCard
        title="Characteristic templates"
        subtitle="Shared by every part family and control plan"
        bodyClassName="flex flex-col gap-3"
        action={
          canManage && (
            <button
              type="button"
              onClick={() => setEditing({})}
              className="flex items-center gap-1 rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm font-medium cursor-pointer">
              <PlusIcon /> Add template
            </button>
          )
        }>
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary-text" />
            <input aria-label="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className={`${inputClass} w-64 max-w-full pl-8`} />
          </label>
          <Switch className="ml-auto text-sm text-secondary-text" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)}>
            Show inactive
          </Switch>
        </div>
        {isLoading && <LoadingScreen size="sm" />}
        {!isLoading && visible.length === 0 && (
          <p className="rounded-xl border border-dashed border-border-color p-6 text-center text-sm text-secondary-text">{templates?.length ? "Nothing matches." : "No templates yet."}</p>
        )}
        <ul className="flex flex-col gap-2">
          {visible.map((t) => (
            <li key={t.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-color bg-primary-bg p-3 transition-colors hover:border-border-dark-color ${t.active ? "" : "opacity-60"}`}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold text-primary-text">
                  {t.name}
                  <span className="rounded-md bg-border-color/60 px-1.5 py-0.5 font-mono text-xs font-normal text-secondary-text">{t.characteristicKey}</span>
                  <span className="rounded-full border border-border-color px-2 py-0.5 text-xs font-normal text-secondary-text">{kindOf(t)}</span>
                  {!t.active && <span className="rounded-full bg-border-color/60 px-2 py-0.5 text-xs font-normal text-secondary-text">Inactive</span>}
                </p>
                <p className="text-sm text-secondary-text">
                  {describe(t)}
                  {t.description ? ` · ${t.description}` : ""}
                </p>
              </div>
              {canManage && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setEditing(t)}
                    aria-label={`Edit ${t.name}`}
                    title="Edit"
                    className="rounded-md p-1.5 text-secondary-text hover:bg-border-color/60 hover:text-primary-text cursor-pointer">
                    <PencilIcon />
                  </button>
                  <Switch
                    checked={t.active}
                    aria-label={`${t.name} active`}
                    title={t.active ? "Active: tap to make inactive" : "Inactive: tap to make active"}
                    onChange={(e) => toggleActive(t, e.target.checked)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </MenuCard>
      {editing && (
        <Dialog title={editing.id ? "Edit template" : "Add template"} onClose={() => setEditing(null)} width="max-w-3xl">
          <CharacteristicForm asTemplate characteristic={editing.id ? editing : undefined} onDone={() => setEditing(null)} />
        </Dialog>
      )}
    </div>
  );
};

export default SettingsProcessControl;
