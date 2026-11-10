import { useToast } from "../../contexts/ToastProvider";
import { useIntegrationSettings, useSaveImportSettings } from "../../hooks/useIntegrations";
import { describeApiError } from "../../lib/api-client";
import { ENTITY_LABELS, ON_MISSING, SCHEDULES, WRITE_MODES } from "../../lib/integrations";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import MenuCard from "../ui/MenuCard";

/**
 * What an import of one kind of record may do (plan §6.7): add new only, add and update, or update only; match records made by hand; what happens when a
 * record disappears; a schedule. Saved as each choice is made (shown at once, put back if the server refuses). Non-conformances are fixed to "add new only".
 */
const ImportSettingsCard = ({ connection, entityType, readOnly }) => {
  const settings = useIntegrationSettings(connection.id);
  const save = useSaveImportSettings(connection.id);
  const { showToast } = useToast();
  const s = settings.data?.find((x) => x.entityType === entityType);
  if (!s) return null;
  const isFile = connection.provider?.key === "csv";
  const set = (patch) =>
    save.mutate({ entityType, ...patch }, { onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  const locked = readOnly || s.fixed;
  const label = ENTITY_LABELS[entityType]?.toLowerCase() ?? "these records";
  return (
    <MenuCard
      title={isFile ? `${ENTITY_LABELS[entityType] ?? "Records"} already in Fortress` : "Import settings"}
      subtitle={isFile ? "What importing this file may do to records that are already there. Every import records the settings it used." : `What an import of ${label} may do. Every import records the settings it used.`}>
      {s.fixed && (
        <Callout tone="info" className="mb-3">
          Non-conformances are only ever added: once in Fortress their investigation, containment and stage are managed there, so a later import never changes them.
        </Callout>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ComboField
          label="What an import may do"
          value={s.writeMode}
          onChange={(v) => v && v !== s.writeMode && set({ writeMode: v })}
          options={WRITE_MODES}
          hint={WRITE_MODES.find((m) => m.value === s.writeMode)?.hint}
          required
          disabled={locked}
        />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-secondary-text">Records made by hand</span>
          <label className="flex items-start gap-2 text-sm text-primary-text">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={s.matchExisting}
              disabled={locked || s.writeMode === "add_only"}
              onChange={(e) => set({ matchExisting: e.target.checked })}
            />
            <span>Match a record already in Fortress with the same code, instead of adding it again</span>
          </label>
          {s.writeMode === "add_only" && !s.fixed && <span className="text-xs text-secondary-text">Not used while an import only adds new records.</span>}
        </div>
        {!isFile && (
        <ComboField
          label="When a record disappears from the source"
          value={s.onMissing}
          onChange={(v) => v && v !== s.onMissing && set({ onMissing: v })}
          options={ON_MISSING.map((o) => ({ ...o, disabled: o.value === "deactivate" && !s.canDeactivate }))}
          hint="Nothing is ever deleted. Acted on by scheduled syncs."
          required
          disabled={readOnly}
        />
        )}
        {!isFile && (
        <ComboField
          label="Runs"
          value={s.schedule}
          onChange={(v) => v && v !== s.schedule && set({ schedule: v })}
          options={SCHEDULES}
          hint={isFile ? "An uploaded file is imported when someone uploads it." : "Daily runs start with scheduled syncs."}
          required
          disabled={readOnly || isFile}
        />
        )}
      </div>
    </MenuCard>
  );
};

export default ImportSettingsCard;
