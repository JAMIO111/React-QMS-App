import { useState } from "react";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import { useResolution } from "../../hooks/useProcessControl";
import { FormError, SelectField } from "../master-data/shared";
import ResolutionView from "./ResolutionView";

/**
 * What an operator would get for a part (and optionally one operation): the plan revision that
 * applies and its requirements resolved for that part, or why an inspection could not start.
 * `parts` are offered for choice; with a single fixed `partId` no picker is shown.
 */
const RequirementPreview = ({ parts = [], partId: fixedPartId, title = "Preview requirements", subtitle, showPlanLink = true }) => {
  const [partId, setPartId] = useState(fixedPartId ?? null);
  const [operation, setOperation] = useState("");
  const [applied, setApplied] = useState("");
  const query = useResolution({ partId: fixedPartId ?? partId, operationCode: applied || undefined });

  return (
    <MenuCard
      title={title}
      subtitle={subtitle ?? "What an operator would be asked to check for a part, from the effective revision."}
      bodyClassName="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(operation.trim());
        }}>
        {!fixedPartId && (
          <SelectField
            label="Part"
            placeholder="Choose a part"
            value={partId}
            onChange={setPartId}
            options={parts.map((p) => ({ value: p.id, label: `${p.partNumber} · ${p.name}` }))}
            className="w-72"
          />
        )}
        <Field label="Operation" value={operation} onChange={(e) => setOperation(e.target.value)} maxLength={30} hint="Optional, e.g. OP-020" className="w-48" />
        <button type="submit" className="mb-5 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-2 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
          Apply
        </button>
      </form>
      {!fixedPartId && !partId && <p className="text-sm text-secondary-text">{parts.length ? "Choose a part to preview." : "The plan's scope has no active parts."}</p>}
      {query.isLoading && (fixedPartId || partId) && <p className="text-sm text-secondary-text">Resolving…</p>}
      {query.error && <FormError error={query.error} />}
      {query.data && <ResolutionView resolution={query.data} showPlanLink={showPlanLink} />}
    </MenuCard>
  );
};

export default RequirementPreview;
