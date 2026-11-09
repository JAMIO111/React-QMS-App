import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import { useIntegrationConnections, useIntegrationProviders } from "../../hooks/useIntegrations";
import { usePermissions } from "../../hooks/useQmsApi";
import { STATUS } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import ConnectionForm from "../integrations/ConnectionForm";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import { ErrorNotice } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

export const StatusPill = ({ status }) => {
  const s = STATUS[status] ?? STATUS.draft;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

/** Settings → Integrations: the systems this organisation connects to Fortress. */
const SettingsIntegrations = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const connections = useIntegrationConnections();
  const providers = useIntegrationProviders();
  const [adding, setAdding] = useState(false);
  const canManage = can("integrations.manage");
  if (connections.isLoading || providers.isLoading) return <LoadingScreen />;
  if (connections.error) return <ErrorNotice error={connections.error} />;
  const list = connections.data ?? [];
  return (
    <div className="flex flex-col gap-4 p-4">
      <MenuCard
        title="Connections"
        subtitle="Each connection is one outside system (an ERP, a spreadsheet drop) whose data Fortress can read. A connection is set up, tested, marked ready, then activated by a second person."
        action={canManage && (
          <CTAButton buttonType="button" type="main" size="lg" onClick={() => setAdding(true)}>
            <span className="flex items-center gap-1"><PlusIcon /> Add connection</span>
          </CTAButton>
        )}>
        {list.length === 0 ? (
          <Callout tone="info" title="No connections yet">Nothing is imported or synchronised until a connection is activated.</Callout>
        ) : (
          <ul aria-label="Connections" className="flex flex-col divide-y divide-border-color">
            {list.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link to={`/Settings/Integrations/${c.id}`} className="text-sm font-medium text-link-color hover:underline">{c.name}</Link>
                  <span className="text-xs text-secondary-text">{c.provider.name} · {c.externalSystem}</span>
                </div>
                <span className="text-xs text-secondary-text">{c.lastTest ? `Tested ${formatDateTime(c.lastTest.at)}${c.lastTest.ok ? "" : " (failed)"}` : "Not tested"}</span>
                <StatusPill status={c.status} />
              </li>
            ))}
          </ul>
        )}
      </MenuCard>
      {adding && <ConnectionForm providers={providers.data ?? []} onClose={() => setAdding(false)} onCreated={(c) => c?.id && navigate(`/Settings/Integrations/${c.id}`)} />}
    </div>
  );
};

export default SettingsIntegrations;
