import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import LoadingScreen from "../ui/LoadingScreen";
import { ChartNoAxesCombinedIcon, ClipboardCheckIcon, GaugeIcon, GraduationCapIcon, TriangleAlertIcon, TruckIcon } from "@/components/icons";
import SlidingToggle from "../ui/SlidingToggle";

const SettingsNonConformance = lazy(() => import("./SettingsNonConformance"));
const SettingsCalibration = lazy(() => import("./SettingsCalibration"));
const SettingsProcessControl = lazy(() => import("./SettingsProcessControl"));
const SettingsAudits = lazy(() => import("./SettingsAudits"));
const SettingsSupplierQuality = lazy(() => import("./SettingsSupplierQuality"));
const SettingsCompetence = lazy(() => import("./SettingsCompetence"));
const CustomFieldsSettings = lazy(() => import("../custom-fields/CustomFieldsSettings"));

/**
 * The module lists and set-up, one tab per module. A tab shows only to people who may read that module; `manage` decides whether the
 * description says they can change it. The tab is kept in the address (`?tab=`), so a link can open a module directly.
 */
const DATA_TABS = [
  {
    value: "non-conformance",
    icon: TriangleAlertIcon,
    label: "Non-conformance",
    read: "ncr.read",
    manage: "lookups.manage",
    description: "Lists used when recording non-conformances. Switch an entry off to retire it without losing history.",
    Component: SettingsNonConformance,
  },
  {
    value: "calibration",
    icon: GaugeIcon,
    label: "Calibration",
    read: "calibration.read",
    manage: "calibration.manage",
    description:
      "Gauge types set the default calibration interval and the characteristics checked at each calibration. A new gauge copies them; each gauge can then be adjusted.",
    Component: SettingsCalibration,
  },
  {
    value: "process-control",
    icon: ChartNoAxesCombinedIcon,
    label: "Process control",
    read: "process_control.read",
    manage: "process_control.manage",
    description:
      "Characteristic templates are reusable checks you choose when adding a characteristic to a draft control plan revision. Choosing one copies its values, so later changes here never alter existing plans.",
    Component: SettingsProcessControl,
  },
  {
    value: "audits",
    icon: ClipboardCheckIcon,
    label: "Audits",
    read: "audits.read",
    manage: "audits.manage",
    description: "How audit findings are classified.",
    Component: SettingsAudits,
  },
  {
    value: "supplier-quality",
    icon: TruckIcon,
    label: "Supplier quality",
    read: "supplier_quality.read",
    manage: "supplier_quality.configure",
    description: "Supplier classifications, qualification questionnaires, the risk model and the performance scoring model.",
    Component: SettingsSupplierQuality,
  },
  {
    value: "competence",
    icon: GraduationCapIcon,
    label: "Competence",
    read: "competence.read",
    manage: "competence.manage",
    description: "Skill categories, the skills people can be assessed on, and the positions that say which skills at which level each one needs.",
    Component: SettingsCompetence,
  },
  {
    value: "custom-fields",
    label: "Custom fields",
    read: "custom_fields.manage",
    manage: "custom_fields.manage",
    description: "Your organisation's own fields on parts, machines, gauges, suppliers, non-conformances, 8Ds and other records. Everyone who can see a record sees its fields.",
    Component: CustomFieldsSettings,
  },
];

/** Settings → Data Management: the module lists and set-up, with a sticky header and a tab per module. */
const SettingsDataManagement = () => {
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const tabs = DATA_TABS.filter((t) => can(t.read));
  const current = tabs.find((t) => t.value === params.get("tab")) ?? tabs[0];

  if (!current) {
    return <p className="p-4 text-secondary-text">You have no access to any module's lists. Ask an administrator for the permission you need.</p>;
  }
  const choose = (value) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", value);
        return next;
      },
      { replace: true },
    );
  const { Component } = current;

  return (
    <div className="flex w-full flex-col">
      <header className="sticky -top-5 z-20 -mx-5 -mt-5 mb-4 flex flex-col gap-3 border-b border-border-color bg-primary-bg/95 px-5 pb-3 pt-5 backdrop-blur">
        <div>
          <h2 className="text-2xl font-semibold text-primary-text">Data Management</h2>
          <p className="text-sm text-secondary-text">
            {current.description}
            {can(current.manage) ? "" : " You can view these; someone with the right permission can change them."}
          </p>
        </div>
        <div className="overflow-x-auto">
          <SlidingToggle
            mode="tabs"
            ariaLabel="Data Management sections"
            value={current.value}
            onChange={choose}
            options={tabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon, id: `data-tab-${t.value}`, controls: "data-tab-panel" }))}
          />
        </div>
      </header>
      <section id="data-tab-panel" role="tabpanel" aria-labelledby={`data-tab-${current.value}`}>
        <Suspense fallback={<LoadingScreen size="sm" />}>
          <Component key={current.value} />
        </Suspense>
      </section>
    </div>
  );
};

export default SettingsDataManagement;
