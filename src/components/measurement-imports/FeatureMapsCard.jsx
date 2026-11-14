import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { PlusIcon, Trash2Icon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useFeatureMapMutation, useFeatureMaps, useMeasurementProfiles } from "../../hooks/useMeasurementImports";
import { describeApiError } from "../../lib/api-client";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";

const KEY = /^[A-Z][A-Z0-9_]{0,39}$/;

/**
 * The part's remembered CMM feature matches (CM4): when a measurement file names a feature this way, it is matched to that characteristic before the
 * balloon number is tried. Saved from an import's preview ("Remember the matches I make") or added here.
 */
const FeatureMapsCard = ({ partId, canEdit }) => {
  const maps = useFeatureMaps(partId);
  const profiles = useMeasurementProfiles();
  const mutation = useFeatureMapMutation();
  const { showToast } = useToast();
  const [feature, setFeature] = useState("");
  const [characteristicKey, setCharacteristicKey] = useState("");
  const [profileId, setProfileId] = useState(null);
  const list = maps.data?.data ?? [];
  const keyOk = KEY.test(characteristicKey.trim().toUpperCase());
  const add = () =>
    mutation.mutate(
      { action: "save", partId, body: { featureName: feature.trim(), characteristicKey: characteristicKey.trim().toUpperCase(), profileId: profileId ?? null } },
      {
        onSuccess: () => {
          setFeature("");
          setCharacteristicKey("");
        },
        onError: (e) => showToast({ type: "error", title: "Not saved", message: describeApiError(e) }),
      },
    );

  if (!canEdit && list.length === 0) return null;
  return (
    <MenuCard title="CMM feature matches" subtitle="When a measurement file names a feature like this, it is matched to that characteristic before the balloon number is tried.">
      {maps.error && <Callout tone="error">{describeApiError(maps.error)}</Callout>}
      {list.length === 0 ? (
        <p className="text-sm text-secondary-text">None yet. Matches made by hand in an import&apos;s preview can be remembered here.</p>
      ) : (
        <ul aria-label="CMM feature matches" className="flex flex-col divide-y divide-border-color">
          {list.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-primary-text">
                  <strong className="font-medium">{m.featureName}</strong> → <span className="font-mono">{m.characteristicKey}</span>
                </span>
                <span className="text-xs text-secondary-text">
                  {m.profile ? m.profile.name : "Any profile"} · {formatDateTime(m.createdAt)}{m.createdBy ? ` · ${m.createdBy}` : ""}
                </span>
              </div>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove the match for ${m.featureName}`}
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ action: "end", id: m.id }, { onError: (e) => showToast({ type: "error", title: "Not removed", message: describeApiError(e) }) })}
                  className="rounded-lg p-1.5 text-error-color hover:bg-secondary-text/5 cursor-pointer">
                  <Trash2Icon className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-3 grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <Field label="Feature in the file" value={feature} onChange={(e) => setFeature(e.target.value)} maxLength={200} />
          <Field
            label="Characteristic key"
            value={characteristicKey}
            onChange={(e) => setCharacteristicKey(e.target.value.toUpperCase())}
            error={characteristicKey && !keyOk ? "Capitals, digits and _, starting with a letter" : undefined}
            maxLength={40}
          />
          <ComboField label="Profile" value={profileId} onChange={setProfileId} placeholder="Any profile" options={(profiles.data?.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
          <CTAButton type="secondary" size="md" icon={PlusIcon} disabled={!feature.trim() || !keyOk} loading={mutation.isPending} onClick={add}>
            Add
          </CTAButton>
        </div>
      )}
    </MenuCard>
  );
};

export default FeatureMapsCard;
