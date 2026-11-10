import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightIcon } from "@/components/icons";
import { useIntegrationConflicts, useIntegrationConnections, useRecentIntegrationRuns } from "../../hooks/useIntegrations";
import { useOrganisationDetails, usePermissions, useUpdateOrganisation } from "../../hooks/useQmsApi";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import Switch from "../ui/Switch";
import { ENTITY_LABELS, INTEGRATION_CATALOGUE, RUN_KINDS, STATUS, runSummary } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import ProviderLogo from "../integrations/ProviderLogo";
import { RunStatusPill } from "../integrations/ImportsCard";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import CTAButton from "@/components/CTAButton";

export const StatusPill = ({ status }) => {
  const s = STATUS[status] ?? STATUS.draft;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

const Badge = ({ available }) =>
  available ? (
    <span className="whitespace-nowrap rounded-full bg-success-color/15 px-2 py-0.5 text-xs font-medium text-success-color">Available</span>
  ) : (
    <span className="whitespace-nowrap rounded-full bg-border-color px-2 py-0.5 text-xs font-medium text-secondary-text">Coming soon</span>
  );

/** One system on the grid: its logo, what it does, and how to start (only for the ones that are built). */
const ProviderCard = ({ item, action }) => (
  <li
    aria-label={item.name}
    className={`flex gap-4 rounded-2xl border border-border-color bg-primary-bg p-4`}>
    <ProviderLogo mark={item.mark} name={item.name} />
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-primary-text">{item.name}</h3>
        <Badge available={item.available} />
      </div>
      <p className="text-xs text-secondary-text">{item.description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  </li>
);

/**
 * Advanced imports: the formula editor in the file import and the template manager (E6). Shown to everyone who sees integrations; switched by people
 * who manage the organisation. Optimistic: the switch moves at once and goes back with a message if the server refuses.
 */
const AdvancedImports = () => {
  const { can } = usePermissions();
  const org = useOrganisationDetails();
  const update = useUpdateOrganisation();
  const { showToast } = useToast();
  const [optimistic, setOptimistic] = useState(null);
  const on = optimistic ?? !!org.data?.settings?.advancedImports;
  const toggle = () => {
    const next = !on;
    setOptimistic(next);
    update.mutate(
      { body: { settings: { advancedImports: next } }, reason: `Advanced imports: ${next ? "on" : "off"}` },
      {
        onError: (e) => showToast({ type: "error", title: "Not changed", message: describeApiError(e) }),
        onSettled: () => setOptimistic(null),
      }
    );
  };
  return (
    <MenuCard
      title="Advanced imports"
      subtitle="Formulas in the file import, and the template manager."
      action={on && <CTAButton to="/Settings/Integrations/Templates" type="secondary" size="md">Manage templates</CTAButton>}>
      <div className="flex items-start justify-between gap-4">
        <p id="advanced-imports" className="text-sm text-secondary-text">
          When on, a field can be filled by a formula such as <span className="font-mono">CONCAT("M-", UPPER([Code]))</span>, and import templates can be renamed, duplicated, archived and their earlier versions brought back.
        </p>
        <Switch aria-label="Advanced imports" aria-describedby="advanced-imports" checked={on} disabled={!can("organisation.manage") || !org.data} onChange={toggle} />
      </div>
    </MenuCard>
  );
};

/** The page itself (only mounted for people who may see integrations, so nothing is fetched for anyone else). */
const IntegrationsHome = () => {
  const { can } = usePermissions();
  const connections = useIntegrationConnections();
  const runs = useRecentIntegrationRuns();
  const waiting = useIntegrationConflicts({ pageSize: 1 });
  const toReview = waiting.data?.openCount ?? 0;
  const canImport = can("integrations.run");
  // Every connection (the one file imports use, a REST API set up for later), reachable for its files and history.
  const others = connections.data ?? [];
  const recent = runs.data?.data ?? [];
  const actionFor = (item) =>
    item.key === "csv" && canImport ? (
      <CTAButton to="/Settings/Integrations/csv" type="main" size="md">
        <span className="flex items-center gap-1">Import a file <ArrowRightIcon /></span>
      </CTAButton>
    ) : null;
  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard title="Integrations" subtitle="Bring records into Fortress from the systems you already use. Nothing is written until you import.">
        <ul aria-label="Integrations" className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {INTEGRATION_CATALOGUE.map((item) => <ProviderCard key={item.key} item={item} action={actionFor(item)} />)}
        </ul>
      </MenuCard>

      {toReview > 0 && (
        <Callout
          tone="warning"
          title={toReview === 1 ? "1 imported value is waiting for review" : `${toReview} imported values are waiting for review`}
          action={<CTAButton to="/Settings/Integrations/Review" type="secondary" size="md">Review values</CTAButton>}>
          Fields set to Review were not changed where a source sent a different value.
        </Callout>
      )}

      <AdvancedImports />

      {recent.length > 0 && (
        <MenuCard title="Recent imports" subtitle="The latest imports and previews, newest first.">
          <ul aria-label="Recent imports" className="flex flex-col divide-y divide-border-color">
            {recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link to={`/Settings/Integrations/${r.connection.id}/runs/${r.id}`} className="text-sm font-medium text-link-color hover:underline">
                    {RUN_KINDS[r.kind]} · {ENTITY_LABELS[r.entityType] ?? r.entityType}{r.file ? ` · ${r.file.name}` : ""}
                  </Link>
                  <span className="text-xs text-secondary-text">{runSummary(r)}</span>
                </div>
                <span className="text-xs text-secondary-text">{formatDateTime(r.requestedAt)}{r.requestedBy ? ` · ${r.requestedBy.name}` : ""}</span>
                <RunStatusPill status={r.status} />
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      {others.length > 0 && (
        <MenuCard title="Connections" subtitle="Where imported records came from. Open one to see its files and history.">
          <ul aria-label="Connections" className="flex flex-col divide-y divide-border-color">
            {others.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link to={`/Settings/Integrations/${c.id}`} className="text-sm font-medium text-link-color hover:underline">{c.name}</Link>
                  <span className="text-xs text-secondary-text">{c.provider.name} · {c.externalSystem}</span>
                </div>
                <StatusPill status={c.status} />
              </li>
            ))}
          </ul>
        </MenuCard>
      )}
    </div>
  );
};

/** Settings → Integrations: the systems this organisation can bring records in from. Controller seat holders only (the database enforces it). */
const SettingsIntegrations = () => {
  const { can } = usePermissions();
  if (!can("integrations.read")) {
    return (
      <div className="p-4">
        <Callout tone="info" title="Integrations are for Controller seat holders">
          Setting up and running integrations needs a Controller seat and a role that allows it. Ask whoever manages your subscription to give you a Controller seat.
        </Callout>
      </div>
    );
  }
  return <IntegrationsHome />;
};

export default SettingsIntegrations;
