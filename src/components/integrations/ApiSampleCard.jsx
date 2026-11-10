import { useState } from "react";
import { useApiSample } from "../../hooks/useIntegrations";
import { describeApiError } from "../../lib/api-client";
import { ENTITY_LABELS, apiMappingPath } from "../../lib/integrations";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import MenuCard from "../ui/MenuCard";
import CTAButton from "@/components/CTAButton";

/**
 * What an API connection sends (IN7): the first page of one kind of record, read through the same guarded connector as an import, shown as columns
 * (nested fields with dots) and rows. Nothing is stored. The column names are what an import template maps from.
 */
const ApiSampleCard = ({ connection }) => {
  const kinds = Object.keys(connection.config?.entities ?? {});
  const [entityType, setEntityType] = useState(kinds[0] ?? null);
  const sample = useApiSample(connection.id);
  const chosen = kinds.includes(entityType) ? entityType : kinds[0] ?? null;
  const data = sample.data;
  return (
    <MenuCard title="What the API sends" subtitle="Reads the first page of one kind of record, without importing anything. Map fields turns these into an import template."
      action={kinds.length > 0 && <CTAButton to={apiMappingPath(connection.id, chosen)} type="main" size="md">Map fields</CTAButton>}>
      {kinds.length === 0 ? (
        <p className="text-sm text-secondary-text">Say in the connection's settings where the API gives each kind of record.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <ComboField label="Records" value={chosen} onChange={setEntityType} options={kinds.map((k) => ({ value: k, label: ENTITY_LABELS[k] ?? k }))} required />
            </div>
            <CTAButton type="secondary" size="md" className="mb-1" onClick={() => sample.mutate(chosen)} loading={sample.isPending} disabled={!chosen}>
              Read a sample
            </CTAButton>
          </div>
          {sample.error && <Callout tone="error" title="The API could not be read">{describeApiError(sample.error)}</Callout>}
          {data && data.rows.length === 0 && <p className="text-sm text-secondary-text">The API sent no records.</p>}
          {data && data.rows.length > 0 && (
            <>
              <p className="text-xs text-secondary-text">{data.columns.length} columns · first {data.rows.length} records</p>
              <div className="overflow-x-auto rounded-lg border border-border-color">
                <table aria-label="Sample from the API" className="min-w-full text-left text-xs">
                  <thead className="bg-secondary-bg">
                    <tr>{data.columns.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1.5 font-mono text-secondary-text">{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {data.rows.slice(0, 10).map((r) => (
                      <tr key={r.r} className="border-t border-border-color">
                        {data.columns.map((c) => <td key={c} className="max-w-[16rem] truncate whitespace-nowrap px-2 py-1.5 text-primary-text">{r.v[c]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </MenuCard>
  );
};

export default ApiSampleCard;
