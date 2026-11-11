import MenuCard from "../ui/MenuCard";
import LoadingScreen from "../ui/LoadingScreen";
import LoadingButton from "../ui/LoadingButton";
import Switch from "@/components/ui/Switch";
import Callout from "../ui/Callout";
import { BellIcon, MailIcon } from "@/components/icons";
import { ApiUnavailable } from "./SettingsOrganisation";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import {
  useEmailDelivery,
  useNotificationPreferences,
  useResetNotificationPreferences,
  useSetNotificationPreference,
} from "../../hooks/useNotifications";

const ACTIONS = ["created", "updated", "deleted"];

/** Groups preferences by module, then by entity (one row each with up to three switches). */
export function groupPreferences(preferences) {
  const groups = new Map();
  for (const p of preferences ?? []) {
    if (!groups.has(p.group)) groups.set(p.group, new Map());
    const entities = groups.get(p.group);
    if (!entities.has(p.entity)) entities.set(p.entity, {});
    entities.get(p.entity)[p.action] = p;
  }
  return [...groups].map(([group, entities]) => ({ group, rows: [...entities].map(([entity, actions]) => ({ entity, actions })) }));
}

/** The email choice for one event: an envelope that is on or off. Only offered while the event is shown in the app. */
const EmailToggle = ({ p, label, onChange }) => {
  const on = p.enabled && p.email;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={p.enabled ? (on ? "Also emailed to you — click to stop" : "Click to have it emailed too") : "Switch it on in the app first"}
      disabled={!p.enabled}
      onClick={() => onChange(!on)}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md border text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "border-theme bg-theme/15 text-theme" : "border-border-color text-tertiary-text hover:text-secondary-text"
      }`}>
      <MailIcon aria-hidden="true" />
    </button>
  );
};

const SettingsNotifications = () => {
  const { data: preferences, isLoading, error } = useNotificationPreferences();
  const { data: delivery } = useEmailDelivery();
  const setPreference = useSetNotificationPreference();
  const reset = useResetNotificationPreferences();
  const { showToast } = useToast();

  if (isLoading) return <LoadingScreen />;
  if (error) return <ApiUnavailable error={error} />;

  const fail = (e) => showToast({ type: "error", title: "Could not save", message: describeApiError(e) });
  const toggle = (p, enabled) =>
    setPreference.mutate({ eventKey: p.eventKey, enabled: enabled === p.defaultEnabled ? null : enabled }, { onError: fail });
  const toggleEmail = (p, email) =>
    setPreference.mutate({ eventKey: p.eventKey, email: email === p.emailDefault ? null : email }, { onError: fail });
  const groups = groupPreferences(preferences);
  const anyOverride = (preferences ?? []).some((p) => p.overridden || p.emailOverridden);

  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Notifications"
        subtitle="Choose which changes appear in your notification bell, and which are also emailed to you. Defaults follow your role and your subscription package, and you only see events you have access to. Your own changes never notify you."
        action={
          <LoadingButton
            loading={reset.isPending}
            disabled={!anyOverride}
            onClick={() => reset.mutate(undefined, { onError: fail })}>
            Reset to defaults
          </LoadingButton>
        }
      />
      {delivery && !delivery.sending && (
        <Callout tone="info" title="Emails are not being sent yet">
          Your email choices are saved, but this server has no mail provider set up, so nothing is emailed until it has one.
        </Callout>
      )}
      {groups.length === 0 && (
        <MenuCard title="Nothing to choose from">
          <p className="text-sm text-secondary-text">Your access does not include any notification events yet.</p>
        </MenuCard>
      )}
      {groups.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-secondary-text">
          <span className="inline-flex items-center gap-1"><BellIcon aria-hidden="true" /> The switch: in your notification bell</span>
          <span className="inline-flex items-center gap-1"><MailIcon aria-hidden="true" /> The envelope: also by email</span>
        </p>
      )}
      {groups.map(({ group, rows }) => (
        <MenuCard key={group} title={group} bodyClassName="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-tertiary-text">
                <th className="pb-2 font-medium">Record</th>
                {ACTIONS.map((a) => (
                  <th key={a} className="w-32 pb-2 text-center font-medium capitalize">
                    {a}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entity, actions }) => (
                <tr key={entity} className="border-t border-border-color">
                  <th scope="row" className="py-2 pr-3 text-left font-normal text-primary-text">
                    {entity}
                  </th>
                  {ACTIONS.map((a) => {
                    const p = actions[a];
                    return (
                      <td key={a} className="py-2 text-center">
                        {p ? (
                          <div className="inline-flex items-center gap-2">
                            <Switch
                              checked={p.enabled}
                              onChange={(e) => toggle(p, e.target.checked)}
                              aria-label={`${entity} ${a}`}
                              title={p.description}
                            />
                            <EmailToggle p={p} label={`${entity} ${a} by email`} onChange={(email) => toggleEmail(p, email)} />
                          </div>
                        ) : (
                          <span className="text-tertiary-text" aria-label="Not available">
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </MenuCard>
      ))}
    </div>
  );
};

export default SettingsNotifications;
