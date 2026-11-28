import { Suspense } from "react";
import { useDataTabs } from "./dataTabs";
import LoadingScreen from "../ui/LoadingScreen";
import Callout from "../ui/Callout";

/**
 * Settings → Data Management: the list and set-up of the module the settings menu has chosen. The menu (Settings.jsx) shows the modules as its nested
 * "Data" level, so there is no header or tab bar here, only the chosen module. `?tab=` in the address says which one.
 */
const SettingsDataManagement = () => {
  const { current, can } = useDataTabs();

  if (!current) {
    return <p className="p-4 text-secondary-text">You have no access to any module's lists. Ask an administrator for the permission you need.</p>;
  }
  const { Component } = current;

  return (
    <div className="flex w-full flex-col gap-4">
      {!can(current.manage) && (
        <Callout tone="info">You can view these; someone with the right permission can change them.</Callout>
      )}
      <section
        key={current.value}
        id="data-tab-panel"
        aria-label={current.label}
        className="animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none"
      >
        <Suspense fallback={<LoadingScreen size="sm" />}>
          <Component />
        </Suspense>
      </section>
    </div>
  );
};

export default SettingsDataManagement;
