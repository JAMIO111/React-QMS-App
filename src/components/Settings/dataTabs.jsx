import { lazy } from "react";
import { useSearchParams } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { BadgeCheckIcon, ChartNoAxesCombinedIcon, ClipboardCheckIcon, FileTextIcon, GaugeIcon, GitPullRequestArrowIcon, GraduationCapIcon, ListTreeIcon, ShieldAlertIcon, TagsIcon, TriangleAlertIcon, TruckIcon } from "@/components/icons";

const SettingsNonConformance = lazy(() => import("./SettingsNonConformance"));
const SettingsCalibration = lazy(() => import("./SettingsCalibration"));
const SettingsProcessControl = lazy(() => import("./SettingsProcessControl"));
const SettingsAudits = lazy(() => import("./SettingsAudits"));
const SettingsSupplierQuality = lazy(() => import("./SettingsSupplierQuality"));
const SettingsCompetence = lazy(() => import("./SettingsCompetence"));
const SettingsDocuments = lazy(() => import("./SettingsDocuments"));
const SettingsRisk = lazy(() => import("./SettingsRisk"));
const SettingsChange = lazy(() => import("./SettingsChange"));
const SettingsFmea = lazy(() => import("./SettingsFmea"));
const SettingsPpap = lazy(() => import("./SettingsPpap"));
const CustomFieldsSettings = lazy(() => import("../custom-fields/CustomFieldsSettings"));

/**
 * The module lists and set-up, one tab per module. A tab shows only to people who may read that module; `manage` decides whether the page
 * says they can only view it. The tab is kept in the address (`?tab=`), so a link can open a module directly.
 */
export const DATA_TABS = [
  {
    value: "non-conformance",
    icon: TriangleAlertIcon,
    label: "Non-conformance",
    read: "ncr.read",
    manage: "lookups.manage",
    Component: SettingsNonConformance,
  },
  {
    value: "calibration",
    icon: GaugeIcon,
    label: "Calibration",
    read: "calibration.read",
    manage: "calibration.manage",
    Component: SettingsCalibration,
  },
  {
    value: "process-control",
    icon: ChartNoAxesCombinedIcon,
    label: "Process control",
    read: "process_control.read",
    manage: "process_control.manage",
    Component: SettingsProcessControl,
  },
  {
    value: "audits",
    icon: ClipboardCheckIcon,
    label: "Audits",
    read: "audits.read",
    manage: "audits.manage",
    Component: SettingsAudits,
  },
  {
    value: "supplier-quality",
    icon: TruckIcon,
    label: "Supplier quality",
    read: "supplier_quality.read",
    manage: "supplier_quality.configure",
    Component: SettingsSupplierQuality,
  },
  {
    value: "competence",
    icon: GraduationCapIcon,
    label: "Competence",
    read: "competence.read",
    manage: "competence.manage",
    Component: SettingsCompetence,
  },
  {
    value: "documents",
    icon: FileTextIcon,
    label: "Documents",
    read: "documentation.manage",
    manage: "documentation.manage",
    Component: SettingsDocuments,
  },
  {
    value: "risk",
    icon: ShieldAlertIcon,
    label: "Risk",
    read: "risk.read",
    manage: "risk.manage",
    Component: SettingsRisk,
  },
  {
    value: "fmea",
    icon: ListTreeIcon,
    label: "FMEA",
    read: "fmea.read",
    manage: "fmea.approve",
    Component: SettingsFmea,
  },
  {
    value: "ppap",
    icon: BadgeCheckIcon,
    label: "PPAP",
    read: "ppap.read",
    manage: "ppap.approve",
    Component: SettingsPpap,
  },
  {
    value: "change",
    icon: GitPullRequestArrowIcon,
    label: "Change",
    read: "change.read",
    manage: "change.manage",
    Component: SettingsChange,
  },
  {
    value: "custom-fields",
    icon: TagsIcon,
    label: "Custom fields",
    read: "custom_fields.manage",
    manage: "custom_fields.manage",
    Component: CustomFieldsSettings,
  },
];

export const DATA_PATH = "/Settings/Data-Management";

/** The address of one Data Management tab. */
export const dataTabPath = (value) => `${DATA_PATH}?tab=${value}`;

/**
 * The tabs the person may open and the one the address names (the first when it names none, or one they cannot see). The settings pane lists
 * them as its nested menu; the page shows the chosen one.
 */
export const useDataTabs = () => {
  const { can } = usePermissions();
  const [params] = useSearchParams();
  const tabs = DATA_TABS.filter((t) => can(t.read));
  const current = tabs.find((t) => t.value === params.get("tab")) ?? tabs[0];
  return { tabs, current, can };
};
