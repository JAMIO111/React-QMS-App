import { useState } from "react";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";
import LoadingScreen from "../ui/LoadingScreen";
import Callout from "../ui/Callout";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import {
  useOrganisationDetails,
  usePermissions,
  useUpdateOrganisation,
} from "../../hooks/useQmsApi";

/**
 * Legacy calibrations in the calibration dashboard: a record imported from an old system has no readings behind its outcome, so by default the
 * dashboard's figures for a period (calibrated, failed, first-time pass rate, results chart) leave them out. The gauges' own state always follows the
 * latest calibration, and legacy records stay on each gauge's history. Optimistic: the switch moves at once and goes back with a message if refused.
 */
const LegacyCalibrations = () => {
  const { can } = usePermissions();
  const org = useOrganisationDetails();
  const update = useUpdateOrganisation();
  const { showToast } = useToast();
  const [optimistic, setOptimistic] = useState(null);
  const on = optimistic ?? !!org.data?.settings?.includeLegacyCalibrations;
  const toggle = () => {
    const next = !on;
    setOptimistic(next);
    update.mutate(
      {
        body: { settings: { includeLegacyCalibrations: next } },
        reason: `Legacy calibrations in the dashboard: ${next ? "on" : "off"}`,
      },
      {
        onError: (e) =>
          showToast({ type: "error", title: "Not changed", message: describeApiError(e) }),
        onSettled: () => setOptimistic(null),
      },
    );
  };
  return (
    <MenuCard
      title="Calibration dashboard"
      subtitle="Which calibrations the dashboard's figures for a period count.">
      <div className="flex items-start justify-between gap-4">
        <p id="legacy-calibrations" className="text-sm text-secondary-text">
          Include legacy calibrations. These are calibrations imported from an
          old system: they say what was concluded but have no readings. When
          this is off (the default) they are left out of the calibrated, failed
          and first-time pass figures and the results chart. Gauges still show
          their last and next due dates from them, and they stay in each gauge's
          history.
        </p>
        <Switch
          aria-label="Include legacy calibrations in the dashboard"
          aria-describedby="legacy-calibrations"
          checked={on}
          disabled={!can("organisation.manage") || !org.data}
          onChange={toggle}
        />
      </div>
    </MenuCard>
  );
};

const SettingsSystemPreferences = () => {
  const org = useOrganisationDetails();
  if (org.isLoading) return <LoadingScreen />;
  if (org.error)
    return (
      <Callout tone="error" role="alert">
        {describeApiError(org.error)}
      </Callout>
    );
  return (
    <div className="flex flex-col gap-4 p-4">
      <LegacyCalibrations />
    </div>
  );
};

export default SettingsSystemPreferences;
