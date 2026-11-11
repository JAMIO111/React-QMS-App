import { useState } from "react";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { AUTH_TYPES, OAUTH_CLIENT_AUTH, DELIMITERS, ENCODINGS, ENTITY_LABELS, PAGING_STYLES, configFromForm, newRestRecord, restEntitiesToRows, restRecordProblem, systemCodeFrom } from "../../lib/integrations";
import { PlusIcon, XIcon } from "@/components/icons";
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
  oauthTokenUrl: c.oauthTokenUrl ?? "",
  oauthScope: c.oauthScope ?? "",
  oauthAudience: c.oauthAudience ?? "",
  oauthClientAuth: c.oauthClientAuth ?? "body",
  timeoutSeconds: c.timeoutSeconds ?? "",
  testPath: c.testPath ?? "",
  records: restEntitiesToRows(c.entities),
});

/**
 * Where a REST API gives each kind of record (IN7): a path below the address, where the list is in the answer, how the API pages and, for incremental
 * imports, which parameter carries the highest value of which field. Every address stays on the connection's own host.
 */
const RestRecords = ({ rows, onChange, disabled }) => {
  const used = new Set(rows.map((r) => r.entityType));
  const setRow = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const options = Object.entries(ENTITY_LABELS).map(([value, label]) => ({ value, label }));
  return (
    <fieldset className="flex flex-col gap-3" aria-label="Records">
      <legend className="text-sm font-medium text-primary-text">Records</legend>
      <p className="text-xs text-secondary-text">For each kind of record: where the API gives it and how it pages. Paths are below the address above.</p>
      {rows.map((r, i) => {
        const label = ENTITY_LABELS[r.entityType] ?? "Record";
        const problem = restRecordProblem(r);
        return (
          <div key={i} role="group" aria-label={`${label} from the API`} className="flex flex-col gap-2 rounded-xl border border-border-color p-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <ComboField label="Kind of record" value={r.entityType} onChange={(v) => setRow(i, { entityType: v })} options={options.map((o) => ({ ...o, disabled: o.value !== r.entityType && used.has(o.value) }))} required disabled={disabled} />
              </div>
              {!disabled && (
                <button type="button" aria-label={`Remove ${label}`} className="mb-1 rounded-lg p-2 text-secondary-text hover:bg-secondary-bg" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  <XIcon />
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Path" value={r.path} onChange={(e) => setRow(i, { path: e.target.value })} required disabled={disabled} placeholder="/v1/items" />
              <Field label="Where the list is in the answer" value={r.recordsPath} onChange={(e) => setRow(i, { recordsPath: e.target.value })} disabled={disabled} placeholder="data" hint="Empty: the answer is the list" />
            </div>
            <ComboField label="Paging" value={r.style} onChange={(v) => setRow(i, { style: v ?? "none" })} options={PAGING_STYLES} required disabled={disabled} />
            {r.style !== "none" && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label="Records per page" type="number" value={r.pageSize} onChange={(e) => setRow(i, { pageSize: e.target.value })} disabled={disabled} placeholder="100" />
                {r.style === "page" && (
                  <>
                    <Field label="Page parameter" value={r.pageParam} onChange={(e) => setRow(i, { pageParam: e.target.value })} disabled={disabled} placeholder="page" />
                    <Field label="Page size parameter" value={r.sizeParam} onChange={(e) => setRow(i, { sizeParam: e.target.value })} disabled={disabled} placeholder="per_page" />
                    <ComboField label="First page" value={r.firstPage} onChange={(v) => setRow(i, { firstPage: v ?? "1" })} options={[{ value: "1", label: "1" }, { value: "0", label: "0" }]} disabled={disabled} />
                  </>
                )}
                {r.style === "offset" && (
                  <>
                    <Field label="Offset parameter" value={r.offsetParam} onChange={(e) => setRow(i, { offsetParam: e.target.value })} disabled={disabled} placeholder="offset" />
                    <Field label="Limit parameter" value={r.limitParam} onChange={(e) => setRow(i, { limitParam: e.target.value })} disabled={disabled} placeholder="limit" />
                  </>
                )}
                {r.style === "cursor" && (
                  <>
                    <Field label="Where the answer gives the next cursor" value={r.nextCursorPath} onChange={(e) => setRow(i, { nextCursorPath: e.target.value })} required disabled={disabled} placeholder="meta.next_cursor" />
                    <Field label="Cursor parameter" value={r.cursorParam} onChange={(e) => setRow(i, { cursorParam: e.target.value })} disabled={disabled} placeholder="cursor" />
                  </>
                )}
                {r.style === "next_link" && (
                  <>
                    {!r.linkHeader && <Field label="Where the answer gives the next link" value={r.nextLinkPath} onChange={(e) => setRow(i, { nextLinkPath: e.target.value })} required disabled={disabled} placeholder="@odata.nextLink" />}
                    <Switch checked={r.linkHeader} disabled={disabled} onChange={(e) => setRow(i, { linkHeader: e.target.checked })}>In the Link header</Switch>
                  </>
                )}
              </div>
            )}
            <Switch checked={r.incremental} disabled={disabled} onChange={(e) => setRow(i, { incremental: e.target.checked })}>
              Incremental imports: ask only for what changed
            </Switch>
            {r.incremental && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="Parameter to send" value={r.incParam} onChange={(e) => setRow(i, { incParam: e.target.value })} required disabled={disabled} placeholder="updated_since" />
                <Field label="Field whose highest value is sent" value={r.incField} onChange={(e) => setRow(i, { incField: e.target.value })} required disabled={disabled} placeholder="updatedAt" hint="Nested fields with dots, e.g. meta.modified" />
              </div>
            )}
            {problem && !disabled && <p className="text-xs text-warning-color">{problem}</p>}
          </div>
        );
      })}
      {!disabled && used.size < Object.keys(ENTITY_LABELS).length && (
        <CTAButton type="neutral" size="md" className="self-start" onClick={() => onChange([...rows, newRestRecord(null)])}>
          <span className="flex items-center gap-1"><PlusIcon /> Add a kind of record</span>
        </CTAButton>
      )}
    </fieldset>
  );
};

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
        {form.authType === "oauth_client" && (
          <>
            <Field label="Token address" value={form.oauthTokenUrl} onChange={(e) => set({ oauthTokenUrl: e.target.value })} required disabled={disabled} placeholder="https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token" hint="Where the access token is asked for. It may be another host, but it must be allowed under Allowed hosts." />
            <Field label="Scope" value={form.oauthScope} onChange={(e) => set({ oauthScope: e.target.value })} disabled={disabled} placeholder="api://erp/.default" hint="Optional. Words separated by spaces." />
            <Field label="Audience" value={form.oauthAudience} onChange={(e) => set({ oauthAudience: e.target.value })} disabled={disabled} hint="Optional. Some sign-in servers (Auth0, for example) ask for it." />
            <ComboField label="How the client is sent" value={form.oauthClientAuth} onChange={(v) => set({ oauthClientAuth: v ?? "body" })} options={OAUTH_CLIENT_AUTH} required disabled={disabled} />
          </>
        )}
        <Field label="Time allowed per request (seconds)" type="number" value={form.timeoutSeconds} onChange={(e) => set({ timeoutSeconds: e.target.value })} disabled={disabled} hint="Optional, up to 60" />
        <Field label="Test path" value={form.testPath} onChange={(e) => set({ testPath: e.target.value })} disabled={disabled} placeholder="/health" hint="Optional: what Test the connection asks for. Empty: the address itself." />
        <RestRecords rows={form.records ?? []} onChange={(records) => set({ records })} disabled={disabled} />
      </>
    );
  }
  return null;
};

/** Add a connection (pick the provider, name it, give the system a short code and set it up) or change the name and settings of one that is not retired. */
const ConnectionForm = ({ providers, existing, onClose, onCreated, initialProvider }) => {
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [providerKey, setProviderKey] = useState(existing?.provider.key ?? initialProvider ?? "csv");
  const [name, setName] = useState(existing?.name ?? "");
  const [code, setCode] = useState(existing?.externalSystem ?? "");
  const [codeTouched, setCodeTouched] = useState(false);
  const [form, setForm] = useState(toForm(providerKey, existing?.config));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const provider = providers.find((p) => p.key === providerKey);
  const system = codeTouched || existing ? code : systemCodeFrom(name);
  const recordProblem = providerKey === "rest_api" ? (form.records ?? []).map(restRecordProblem).find(Boolean) : null;
  const ok = name.trim() && (existing || /^[a-z][a-z0-9-]{1,39}$/.test(system)) && !recordProblem;

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
    <Dialog title={existing ? `Edit ${existing.name}` : "Add a connection"} onClose={onClose} width={providerKey === "rest_api" ? "max-w-3xl" : "max-w-lg"}>
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
        {provider?.kind === "api" && (
          <Callout tone="info">
            Fortress only calls public https addresses on port 443, never follows redirects and never sends the credential anywhere but this address. Your organisation can also limit which hosts may be called.
          </Callout>
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={mutation.isPending || !ok} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default ConnectionForm;
