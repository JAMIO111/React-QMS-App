import MenuCard from "../ui/MenuCard";
import LoadingScreen from "../ui/LoadingScreen";
import LoadingButton from "../ui/LoadingButton";
import Switch from "@/components/ui/Switch";
import { ApiUnavailable } from "./SettingsOrganisation";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import {
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

const SettingsNotifications = () => {
  const { data: preferences, isLoading, error } = useNotificationPreferences();
  const setPreference = useSetNotificationPreference();
  const reset = useResetNotificationPreferences();
  const { showToast } = useToast();

  if (isLoading) return <LoadingScreen />;
  if (error) return <ApiUnavailable error={error} />;

  const fail = (e) => showToast({ type: "error", title: "Could not save", message: describeApiError(e) });
  const toggle = (p, enabled) =>
    setPreference.mutate({ eventKey: p.eventKey, enabled: enabled === p.defaultEnabled ? null : enabled }, { onError: fail });
  const groups = groupPreferences(preferences);
  const anyOverride = (preferences ?? []).some((p) => p.overridden);

  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Notifications"
        subtitle="Choose which changes appear in your notification bell. Defaults follow your role and your subscription package, and you only see events you have access to. Your own changes never notify you."
        action={
          <LoadingButton
            type="button"
            loading={reset.isPending}
            disabled={!anyOverride}
            onClick={() => reset.mutate(undefined, { onError: fail })}
            className="rounded-lg border border-border-color px-3 py-1.5 text-sm text-primary-text hover:border-border-dark-color cursor-pointer">
            Reset to defaults
          </LoadingButton>
        }
      />
      {groups.length === 0 && (
        <MenuCard title="Nothing to choose from">
          <p className="text-sm text-secondary-text">Your access does not include any notification events yet.</p>
        </MenuCard>
      )}
      {groups.map(({ group, rows }) => (
        <MenuCard key={group} title={group} bodyClassName="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-tertiary-text">
                <th className="pb-2 font-medium">Record</th>
                {ACTIONS.map((a) => (
                  <th key={a} className="w-24 pb-2 text-center font-medium capitalize">
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
                          <Switch
                            checked={p.enabled}
                            onChange={(e) => toggle(p, e.target.checked)}
                            aria-label={`${entity} ${a}`}
                            title={p.description}
                          />
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
