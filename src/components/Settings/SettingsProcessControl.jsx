import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useCharacteristicTemplates, useProcessControlMutation } from "../../hooks/useProcessControl";
import { usePermissions } from "../../hooks/useQmsApi";
import { describeApiError } from "../../lib/api-client";
import MenuCard from "../ui/MenuCard";
import Dialog from "../ui/Dialog";
import Switch from "../ui/Switch";
import CharacteristicForm from "../process-control/CharacteristicForm";
import LoadingScreen from "../ui/LoadingScreen";

const link = "text-link-color hover:underline cursor-pointer";

const describe = (t) => {
  if (t.dataType === "attribute") return "Pass / fail";
  if (t.valueSource === "part_spec") return `Part-specific (${t.specKey ?? "—"})${t.unitCode ? ` · ${t.unitCode}` : ""}`;
  return `${t.nominal ?? "—"} (${t.lowerLimit ?? "—"} to ${t.upperLimit ?? "—"})${t.unitCode ? ` ${t.unitCode}` : ""}`;
};

/** Settings → Process control: reusable characteristics picked from a dropdown on a control plan revision. */
const SettingsProcessControl = () => {
  const { can } = usePermissions();
  const canManage = can("process_control.manage");
  const [showInactive, setShowInactive] = useState(false);
  const { data: templates, isLoading, error } = useCharacteristicTemplates({ includeInactive: showInactive });
  const mutation = useProcessControlMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(null);

  const toggleActive = (t) =>
    mutation.mutate(
      { path: `/characteristic-templates/${t.id}`, method: "PATCH", body: { active: !t.active } },
      {
        onSuccess: () => showToast({ type: "success", title: "Saved", message: `${t.name} ${t.active ? "made inactive" : "made active"}.` }),
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      }
    );

  return (
    <div className="flex w-full grow flex-col gap-3 p-4 pr-2">
      <h2 className="pb-2 text-2xl font-semibold text-primary-text">Process control</h2>
      <p className="text-secondary-text">
        Characteristic templates are reusable checks (for example an outer diameter) that you choose from a dropdown when adding a characteristic to a draft control plan revision. Choosing one copies its values, so
        later changes here never alter existing plans.
        {canManage ? "" : " You can view them; a process control manager can change them."}
      </p>
      {error && <p role="alert" className="text-error-color">{describeApiError(error)}</p>}
      <MenuCard
        title="Characteristic templates"
        subtitle="Shared by every part family and control plan"
        bodyClassName="flex flex-col gap-3"
        action={
          canManage && (
            <button type="button" onClick={() => setEditing({})} className="flex items-center gap-1 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
              <PlusIcon /> Add template
            </button>
          )
        }>
        <Switch checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)}>Show inactive</Switch>
        {isLoading && <LoadingScreen size="sm" />}
        {!isLoading && templates?.length === 0 && <p className="text-secondary-text">No templates yet.</p>}
        <ul className="flex flex-col gap-2">
          {templates?.map((t) => (
            <li key={t.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-color bg-primary-bg p-3 ${t.active ? "" : "opacity-70"}`}>
              <div>
                <p className="font-semibold text-primary-text">
                  {t.name} <span className="text-xs font-normal text-secondary-text">{t.characteristicKey}</span>
                  {!t.active && <span className="ml-2 text-xs font-normal text-secondary-text">(inactive)</span>}
                </p>
                <p className="text-sm text-secondary-text">
                  {describe(t)}
                  {t.description ? ` · ${t.description}` : ""}
                </p>
              </div>
              {canManage && (
                <div className="flex items-center gap-3 text-sm">
                  <button type="button" onClick={() => setEditing(t)} className={link}>Edit</button>
                  <button type="button" disabled={mutation.isPending} onClick={() => toggleActive(t)} className={`${link} disabled:opacity-50`}>{t.active ? "Make inactive" : "Make active"}</button>
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
