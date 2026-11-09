import { useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { AUTH_TYPES, DELIMITERS, ENCODINGS, configFromForm, systemCodeFrom } from "../../lib/integrations";
import { useIntegrationMutation } from "../../hooks/useIntegrations";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import Switch from "../ui/Switch";
import Callout from "../ui/Callout";
import { FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const toForm = (provider, c = {}) => ({
  delimiter: c.delimiter ?? ",",
  encoding: c.encoding ?? "utf-8",
  hasHeader: c.hasHeader !== false,
  baseUrl: c.baseUrl ?? "",
  authType: c.authType ?? "none",
  apiKeyHeader: c.apiKeyHeader ?? "",
  timeoutSeconds: c.timeoutSeconds ?? "",
});

/** The settings of one provider. CSV: how the files are read. REST: where the system is and how it signs people in (never the secret itself). */
export const ConfigFields = ({ provider, form, set, disabled }) => {
  if (provider === "csv") {
    return (
      <>
        <ComboField label="Separator" value={form.delimiter} onChange={(v) => set({ delimiter: v ?? "," })} options={DELIMITERS} required disabled={disabled} />
        <ComboField label="Character set" value={form.encoding} onChange={(v) => set({ encoding: v ?? "utf-8" })} options={ENCODINGS} required disabled={disabled} />
        <Switch checked={form.hasHeader} disabled={disabled} onChange={(e) => set({ hasHeader: e.target.checked })}>
          The first row holds column names
        </Switch>
      </>
    );
  }
  if (provider === "rest_api") {
    return (
      <>
        <Field label="Address" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} required disabled={disabled} placeholder="https://erp.example.com/api" hint="Must start with https://. Addresses on a private network are not allowed." />
        <ComboField label="How we sign in" value={form.authType} onChange={(v) => set({ authType: v ?? "none" })} options={AUTH_TYPES} required disabled={disabled} />
        {form.authType === "api_key" && <Field label="Header name" value={form.apiKeyHeader} onChange={(e) => set({ apiKeyHeader: e.target.value })} required disabled={disabled} placeholder="X-Api-Key" />}
        <Field label="Time allowed per request (seconds)" type="number" value={form.timeoutSeconds} onChange={(e) => set({ timeoutSeconds: e.target.value })} disabled={disabled} hint="Optional" />
      </>
    );
  }
  return null;
};

/** Add a connection (pick the provider, name it, give the system a short code and set it up) or change the name and settings of one that is not retired. */
const ConnectionForm = ({ providers, existing, onClose, onCreated }) => {
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [providerKey, setProviderKey] = useState(existing?.provider.key ?? "csv");
  const [name, setName] = useState(existing?.name ?? "");
  const [code, setCode] = useState(existing?.externalSystem ?? "");
  const [codeTouched, setCodeTouched] = useState(false);
  const [form, setForm] = useState(toForm(providerKey, existing?.config));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const provider = providers.find((p) => p.key === providerKey);
  const system = codeTouched || existing ? code : systemCodeFrom(name);
  const ok = name.trim() && (existing || /^[a-z][a-z0-9-]{1,39}$/.test(system));

  const save = (e) => {
    e.preventDefault();
    if (!ok) return;
    const config = configFromForm(providerKey, form);
    const onError = (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) });
    if (existing) {
      mutation.mutate({ action: "update", id: existing.id, body: { name: name.trim(), config } }, { onSuccess: () => onClose(), onError });
    } else {
      mutation.mutate({ action: "create", body: { providerKey, name: name.trim(), externalSystem: system, config } }, { onSuccess: (c) => { onClose(); onCreated?.(c); }, onError });
    }
  };

  return (
    <Dialog title={existing ? `Edit ${existing.name}` : "Add a connection"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        {!existing && (
          <ComboField
            label="Type of connection"
            value={providerKey}
            onChange={(v) => { setProviderKey(v ?? "csv"); setForm(toForm(v ?? "csv")); }}
            options={providers.map((p) => ({ value: p.key, label: p.name, hint: p.status === "available" ? p.description : `${p.description} (not available yet)`, disabled: p.status !== "available" }))}
            required
          />
        )}
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Sage purchase orders" />
        {!existing && (
          <Field
            label="System code"
            value={system}
            onChange={(e) => { setCode(e.target.value.toLowerCase()); setCodeTouched(true); }}
            required
            maxLength={40}
            hint="Short and fixed once saved. It names where records came from, e.g. sage-200."
          />
        )}
        <ConfigFields provider={providerKey} form={form} set={set} />
        {provider?.kind === "api" && <Callout tone="info">Fortress makes no outbound calls to this system yet. You can set it up and store its credential now.</Callout>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !ok}>{mutation.isPending ? "Saving…" : "Save"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default ConnectionForm;
