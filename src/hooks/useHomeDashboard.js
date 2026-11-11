import { useNcDashboard } from "./useNcr";
import { useCapas, useMyCapaActions } from "./useCapa";
import { useCalibrationDashboard } from "./useCalibration";
import { useProcessControlDashboard } from "./useProcessControl";
import { useSpcAlerts } from "./useSpc";
import { useAuditsDashboard } from "./useAudits";
import { useDocumentsDashboard, useMyDocumentCount } from "./useDocuments";
import { useMyAlertCount } from "./useDocumentation";
import { useSupplierDashboard } from "./useSupplierPerformance";
import { useCompetenceDashboard } from "./useCompetence";
import { useMasterDataDashboard } from "./useMasterData";
import { usePermissions } from "./useQmsApi";
import { readPeriod } from "../lib/dashboardPeriod";
import { HOME_MODULES, homeModules, summarise } from "../lib/homeDashboard";

const NO_PARAMS = new URLSearchParams();
/** The period a module's own dashboard opens on, so the home page and that dashboard share one cached answer. Empty when the module is not readable. */
const periodOf = (key, allowed) => {
  if (!allowed) return {};
  const { fromIso, toIso } = readPeriod(NO_PARAMS, HOME_MODULES.find((m) => m.key === key).period);
  return { from: fromIso, to: toIso };
};
const source = (query) => ({ data: query.data, isLoading: query.isLoading, error: query.error });

/**
 * Everything the home page reports: what needs attention in each module the person may read, and their own to-dos.
 * It asks each module's own dashboard (only where the person holds its read permission), so nothing is worked out twice.
 */
export const useHomeDashboard = () => {
  const { can, isLoading: permissionsLoading } = usePermissions();
  const may = (permission) => !permissionsLoading && can(permission);

  const nc = useNcDashboard(periodOf("nc", may("ncr.read")));
  const capaRunning = useCapas({ pageSize: 1 }, { enabled: may("capa.read") });
  const capaOverdue = useCapas({ overdue: true, pageSize: 1 }, { enabled: may("capa.read") });
  const capaVerify = useCapas({ stage: "awaiting_verification", pageSize: 1 }, { enabled: may("capa.read") });
  const calibration = useCalibrationDashboard(periodOf("calibration", may("calibration.read")));
  const processControl = useProcessControlDashboard(periodOf("processControl", may("process_control.read")));
  const spcAlerts = useSpcAlerts("open", undefined, { enabled: may("process_control.read") && may("spc.read") });
  const audits = useAuditsDashboard(periodOf("audits", may("audits.read")));
  const documents = useDocumentsDashboard(periodOf("documents", may("documentation.read")));
  const supplier = useSupplierDashboard(periodOf("supplier", may("supplier_quality.read")));
  const competence = useCompetenceDashboard(periodOf("competence", may("competence.read")));
  const masterData = useMasterDataDashboard({ enabled: may("master_data.read") });

  const myAlerts = useMyAlertCount({ enabled: may("documentation.read") });
  const myDocuments = useMyDocumentCount({ enabled: may("documentation.read") });
  const myActions = useMyCapaActions("open", { enabled: may("capa.read") });

  const capaReady = capaRunning.data && capaOverdue.data && capaVerify.data;
  const sources = {
    nc: source(nc),
    capa: {
      data: capaReady ? { running: capaRunning.data.total, overdue: capaOverdue.data.total, awaitingVerification: capaVerify.data.total } : undefined,
      error: capaRunning.error ?? capaOverdue.error ?? capaVerify.error,
    },
    calibration: source(calibration),
    processControl: {
      // SPC alerts are an extra the person may not be allowed to read: the rest of the module still shows.
      data: processControl.data ? { ...processControl.data, openSpcAlerts: spcAlerts.data?.openCount ?? 0 } : undefined,
      error: processControl.error,
    },
    audits: source(audits),
    documents: source(documents),
    supplier: source(supplier),
    competence: source(competence),
    masterData: source(masterData),
  };

  const modules = permissionsLoading ? [] : homeModules(sources, can);
  const personal = [
    may("documentation.read") && {
      key: "alerts",
      label: "Quality alerts to acknowledge",
      count: myAlerts.data?.unacknowledged,
      overdue: myAlerts.data?.overdue ?? 0,
      to: "/Documentation/My-Alerts",
    },
    may("documentation.read") && {
      key: "documents",
      label: "Documents to read",
      count: myDocuments.data?.toRead,
      overdue: myDocuments.data?.overdue ?? 0,
      to: "/Documentation/My-Documents",
    },
    may("documentation.read") && {
      key: "reviews",
      label: "Documents waiting for your sign-off",
      count: myDocuments.data?.reviews,
      overdue: 0,
      to: "/Documentation/My-Documents",
    },
    may("capa.read") && {
      key: "actions",
      label: "8D actions assigned to you",
      count: myActions.data?.openCount,
      overdue: 0,
      to: "/CAPA/My-Actions",
    },
  ].filter(Boolean);

  return { modules, summary: summarise(modules), personal, isLoading: permissionsLoading };
};
