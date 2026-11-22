import { useMemo } from "react";
import { Link, Navigate, useNavigate, useOutletContext } from "react-router-dom";
import Callout from "../ui/Callout";
import PortalComplaints, { PortalEvidence } from "./PortalComplaints";
import PortalPeople from "./PortalPeople";
import PortalRegister from "./PortalRegister";
import Content from "./portalContent";
import {
  CAPA_HIDDEN, DOCUMENT_HIDDEN, NCR_HIDDEN, SCAR_HIDDEN,
  capaColumns, capaCsv, capaFilters, capaSearch, documentColumns, documentCsv, documentFilters, documentSearch,
  ncrColumns, ncrCsv, ncrFilters, ncrSearch, scarColumns, scarCsv, scarFilters, scarSearch,
} from "./portalColumns";
import { usePortalCapas, usePortalHome, usePortalNcrs, usePortalScars, usePortalShares } from "../../hooks/usePortal";
import { scarPath, sharedPath } from "../../lib/portal";

/**
 * The portal's menu pages: the registers (non-conformances, corrective action requests for suppliers, 8D reports for customers, documents and alerts)
 * and the pages that are not registers (complaints, certificates, team). Each page is for one kind of party or role and sends anyone else to the dashboard.
 */

/** Everything but the dashboard waits for two-factor authentication when the organisation asks for it. */
function MfaNeeded({ access }) {
  return (
    <Content>
      <Callout tone="warning" title="Two-factor authentication needed" role="alert">
        {access.organisationName} asks everyone who signs in to its portal to use two-factor authentication.{" "}
        <Link to={`/mfa?next=${encodeURIComponent("/portal")}`} className="font-medium text-link-color hover:underline">Set it up or enter your code</Link> to continue.
      </Callout>
    </Content>
  );
}

const Page = ({ children }) => <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col p-4">{children}</div>;

export function PortalNcrsPage() {
  const { access } = useOutletContext();
  const navigate = useNavigate();
  const ncrs = usePortalNcrs(access.organisationId, { enabled: !access.mfaRequired });
  const columns = useMemo(() => ncrColumns(access.organisationId), [access.organisationId]);
  if (access.mfaRequired) return <MfaNeeded access={access} />;
  return (
    <Page>
      <PortalRegister
        storageKey={`portal-ncr-${access.partyKind}`}
        noun="non-conformance"
        plural="non-conformances"
        rows={ncrs.data?.data}
        isLoading={ncrs.isLoading}
        error={ncrs.error}
        onRefresh={ncrs.refetch}
        columns={columns}
        defaultHidden={NCR_HIDDEN}
        defaultSort={{ id: "detectedAt", desc: true }}
        filters={ncrFilters}
        searchText={ncrSearch}
        csvRow={ncrCsv}
        csvName="non-conformances.csv"
        onOpen={(r) => navigate(sharedPath(r.id, access.organisationId))}
        rowLabel={(r) => r.reference}
        ariaLabel="Non-conformances"
        searchPlaceholder="Search reference, title, part, lot"
      />
    </Page>
  );
}

export function PortalScarsPage() {
  const { access } = useOutletContext();
  const navigate = useNavigate();
  const scars = usePortalScars(access.organisationId, { enabled: !access.mfaRequired && access.partyKind === "supplier" });
  const columns = useMemo(() => scarColumns(access.organisationId), [access.organisationId]);
  const rows = scars.data?.data;
  if (access.partyKind !== "supplier") return <Navigate to="/portal" replace />;
  if (access.mfaRequired) return <MfaNeeded access={access} />;
  return (
    <Page>
      <PortalRegister
        storageKey="portal-scar"
        noun="corrective action request"
        plural="corrective action requests"
        rows={rows}
        isLoading={scars.isLoading}
        error={scars.error}
        onRefresh={scars.refetch}
        columns={columns}
        defaultHidden={SCAR_HIDDEN}
        // The list arrives in the order that matters (waiting for a response first, closed last); a header click sorts by anything else.
        filters={scarFilters}
        searchText={scarSearch}
        csvRow={scarCsv}
        csvName="corrective-action-requests.csv"
        onOpen={(r) => navigate(scarPath(r.id, access.organisationId))}
        rowLabel={(r) => r.reference}
        ariaLabel="Corrective action requests"
        searchPlaceholder="Search reference or title"
      />
    </Page>
  );
}

export function PortalCapasPage() {
  const { access } = useOutletContext();
  const navigate = useNavigate();
  const capas = usePortalCapas(access.organisationId, { enabled: !access.mfaRequired && access.partyKind === "customer" });
  const columns = useMemo(() => capaColumns(access.organisationId), [access.organisationId]);
  if (access.partyKind !== "customer") return <Navigate to="/portal" replace />;
  if (access.mfaRequired) return <MfaNeeded access={access} />;
  return (
    <Page>
      <PortalRegister
        storageKey="portal-capa"
        noun="8D report"
        plural="8D reports"
        rows={capas.data?.data}
        isLoading={capas.isLoading}
        error={capas.error}
        onRefresh={capas.refetch}
        columns={columns}
        defaultHidden={CAPA_HIDDEN}
        defaultSort={{ id: "startedAt", desc: true }}
        filters={capaFilters}
        searchText={capaSearch}
        csvRow={capaCsv}
        csvName="8d-reports.csv"
        onOpen={(r) => navigate(sharedPath(r.id, access.organisationId))}
        rowLabel={(r) => r.reference}
        ariaLabel="8D reports"
        searchPlaceholder="Search reference or title"
      />
    </Page>
  );
}

export function PortalDocumentsPage() {
  const { access } = useOutletContext();
  const navigate = useNavigate();
  const shares = usePortalShares(access.organisationId, { enabled: !access.mfaRequired });
  const home = usePortalHome(access.mfaRequired ? undefined : access.organisationId);
  const columns = useMemo(() => documentColumns(access.organisationId), [access.organisationId]);
  // A document or alert the person still has to acknowledge says so in the "Waiting for you" column.
  const rows = useMemo(() => {
    const pending = new Set((home.data?.attention ?? []).filter((i) => i.needsAcknowledgement).map((i) => i.id));
    return (shares.data?.data ?? []).filter((s) => s.kind === "document" || s.kind === "quality_alert").map((s) => ({ ...s, needsAcknowledgement: pending.has(s.id) }));
  }, [shares.data, home.data]);
  if (access.mfaRequired) return <MfaNeeded access={access} />;
  return (
    <Page>
      <PortalRegister
        storageKey="portal-document"
        noun="document or alert"
        plural="documents and alerts"
        rows={rows}
        isLoading={shares.isLoading}
        error={shares.error}
        onRefresh={shares.refetch}
        columns={columns}
        defaultHidden={DOCUMENT_HIDDEN}
        defaultSort={{ id: "sharedAt", desc: true }}
        filters={documentFilters}
        searchText={documentSearch}
        csvRow={documentCsv}
        csvName="documents-and-alerts.csv"
        onOpen={(r) => navigate(sharedPath(r.id, access.organisationId))}
        rowLabel={(r) => r.reference}
        ariaLabel="Documents and alerts"
        searchPlaceholder="Search number or title"
      />
    </Page>
  );
}

export function PortalComplaintsPage() {
  const { access } = useOutletContext();
  if (access.partyKind !== "customer") return <Navigate to="/portal" replace />;
  if (access.mfaRequired) return <MfaNeeded access={access} />;
  return <Content><PortalComplaints access={access} /></Content>;
}

export function PortalCertificatesPage() {
  const { access } = useOutletContext();
  if (access.partyKind !== "customer") return <Navigate to="/portal" replace />;
  if (access.mfaRequired) return <MfaNeeded access={access} />;
  return <Content><PortalEvidence access={access} /></Content>;
}

export function PortalTeamPage() {
  const { access } = useOutletContext();
  if (access.role !== "admin") return <Navigate to="/portal" replace />;
  if (access.mfaRequired) return <MfaNeeded access={access} />;
  return <Content><PortalPeople access={access} /></Content>;
}
