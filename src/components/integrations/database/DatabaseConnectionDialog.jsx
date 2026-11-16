import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../../../contexts/ToastProvider";
import { useAgents } from "../../../hooks/useAgents";
import { useIntegrationMutation } from "../../../hooks/useIntegrations";
import { agentsPath } from "../../../lib/agents";
import { describeApiError } from "../../../lib/api-client";
import { DB_AUTH, DB_ENGINES, FILE_DELIMITERS, FILE_ENCODINGS, databaseConfig, databaseForm, databaseFormProblem, systemCodeFrom } from "../../../lib/integrations";
import Callout from "../../ui/Callout";
import ComboField from "../../ui/ComboField";
import Dialog from "../../ui/Dialog";
import Field from "../../ui/Field";
import Switch from "../../ui/Switch";
import { FormError } from "../../master-data/shared";
import CTAButton from "@/components/CTAButton";

/**
 * A database read through a connector agent (docs/connector-agent-plan.md AG2): which agent reads it, and where the database is. Only settings —
 * the password is typed afterwards on the connection's page and sealed in the browser for the agent. The agent cannot be changed once chosen.
 */
/** A folder's settings (AG5b): where it is on the agent's machine, and how to read its files (as for an uploaded file). */
const FolderFields = ({ f, set }) => (
  <>
    <Field
      label="Folder"
      value={f.folder}
      onChange={(e) => set({ folder: e.target.value })}
      required
      maxLength={260}
      placeholder={"\\\\files01\\exports\\erp"}
      hint={"As the agent's machine knows it: a drive path (C:\\Exports) or a share (\\\\server\\share\\Exports). Add it to \"folders\" in the agent's allowlist.json too."}
    />
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ComboField label="Character set" value={f.fileEncoding} onChange={(v) => set({ fileEncoding: v ?? "auto" })} options={FILE_ENCODINGS} />
      <ComboField label="Separator" value={f.fileDelimiter} onChange={(v) => set({ fileDelimiter: v ?? "auto" })} options={FILE_DELIMITERS} hint="For CSV and text files; Excel files are read as workbooks" />
    </div>
    <Switch checked={f.hasHeader} onChange={(e) => set({ hasHeader: e.target.checked })}>
      The first line holds the column headings
    </Switch>
  </>
);

/** An internal API's settings (AG5c): its address as the agent's machine reaches it, how it signs in and a path to test. */
const RestFields = ({ f, set }) => (
  <>
    <Field
      label="Address"
      value={f.baseUrl}
      onChange={(e) => set({ baseUrl: e.target.value })}
      required
      maxLength={300}
      placeholder="http://erp.factory.local:8080/api"
      hint={'As the agent\'s machine reaches it: http or https, a name or address on your network and the port. Add its host to "hosts" in the agent\'s allowlist.json too.'}
    />
    <ComboField label="How the agent signs in" value={f.authType} onChange={(v) => v && set({ authType: v })} options={DB_AUTH.rest} required
      hint="The key, token or password is typed on the next page, sealed for the agent and never kept by Fortress" />
    {f.authType === "api_key" && (
      <Field label="Header the API key is sent in" value={f.apiKeyHeader} onChange={(e) => set({ apiKeyHeader: e.target.value })} required maxLength={60} placeholder="X-Api-Key" />
    )}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Path to test" value={f.testPath} onChange={(e) => set({ testPath: e.target.value })} maxLength={300} placeholder="/health" hint="Optional: the address itself is asked when empty" />
      <Field label="Timeout (seconds)" type="number" value={f.timeoutSeconds} onChange={(e) => set({ timeoutSeconds: e.target.value })} placeholder="30" hint="1 to 120" />
    </div>
  </>
);

const DatabaseConnectionDialog = ({ engine, existing = null, onClose, onCreated }) => {
  const agents = useAgents();
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [name, setName] = useState(existing?.name ?? "");
  const [system, setSystem] = useState(existing?.externalSystem ?? "");
  const [systemTouched, setSystemTouched] = useState(!!existing);
  const [agentId, setAgentId] = useState(existing?.agent?.id ?? null);
  const [f, setF] = useState(() => databaseForm(engine, existing?.config));
  const [tried, setTried] = useState(false);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const live = useMemo(() => (agents.data?.data ?? []).filter((a) => a.status === "active"), [agents.data]);
  const agentOptions = live.map((a) => ({ value: a.id, label: a.name, hint: a.online ? "Online" : `Offline${a.machineName ? ` · ${a.machineName}` : ""}` }));
  const chosen = live.find((a) => a.id === agentId);
  const code = systemTouched ? system : systemCodeFrom(name);
  const folder = f.engine === "folder";
  const rest = f.engine === "rest";
  const what = folder ? "folder" : rest ? "API" : "database";
  const problem =
    (!existing && !agentId && `Choose the connector agent that reads this ${what}`) ||
    (name.trim().length < 2 && "Give the connection a name") ||
    (!/^[a-z][a-z0-9_-]{1,39}$/.test(code) && "The system code is 2 to 40 lower-case letters, digits, hyphens or underscores, starting with a letter") ||
    databaseFormProblem(f);

  const save = (e) => {
    e.preventDefault();
    setTried(true);
    if (problem) return;
    const config = databaseConfig(f);
    const done = { onError: (err) => showToast({ type: "error", title: existing ? "Not saved" : "Not created", message: describeApiError(err) }) };
    if (existing) {
      mutation.mutate({ action: "update", id: existing.id, body: { name: name.trim(), config } }, { ...done, onSuccess: () => onClose() });
    } else {
      mutation.mutate(
        { action: "create", body: { providerKey: "sql_agent", name: name.trim(), externalSystem: code, agentId, config } },
        { ...done, onSuccess: (c) => (onCreated ? onCreated(c) : onClose()) },
      );
    }
  };

  return (
    <Dialog title={existing ? `Edit ${existing.name}` : folder ? "Connect a folder of files" : rest ? "Connect an internal API" : `Connect ${DB_ENGINES[f.engine]}`} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-4">
        {!existing && rest && (
          <p className="text-sm text-secondary-text">
            A connector agent inside your network calls the API and sends Fortress only the records you ask for. Nothing connects in, and the key stays on the
            agent. The agent calls only hosts on its own allow-list and never follows a redirect.
          </p>
        )}
        {!existing && !folder && !rest && (
          <p className="text-sm text-secondary-text">
            A connector agent inside your network reads the database and sends Fortress only what you ask for. Nothing connects in, and the password stays on
            the agent. You type the password on the next page.
          </p>
        )}
        {!existing && folder && (
          <p className="text-sm text-secondary-text">
            A connector agent inside your network picks up CSV or Excel files from a folder or share and sends them to Fortress, which reads them as it reads
            uploaded files. Nothing connects in. The agent reads the folder as its own Windows service account, and only once the folder is on its allow-list.
          </p>
        )}
        {!existing &&
          (live.length === 0 && !agents.isLoading ? (
            <Callout tone="warning" title="No connector agent yet">
              Install one first, on a Windows machine that can reach the {what}.{" "}
              <Link to={agentsPath()} className="text-link-color hover:underline">
                Add a connector agent
              </Link>
            </Callout>
          ) : (
            <ComboField label="Connector agent" value={agentId} onChange={setAgentId} options={agentOptions} required hint={chosen && !chosen.online ? "This agent is offline: you can set the connection up, but it will not answer until it is back." : "Fixed once the connection is made"} />
          ))}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder={folder ? "ERP exports" : rest ? "ERP API" : "ERP database"} />
          <Field
            label="System code"
            value={code}
            onChange={(e) => {
              setSystemTouched(true);
              setSystem(e.target.value);
            }}
            required
            disabled={!!existing}
            hint="Names where imported records came from (e.g. erp). Fixed once made."
          />
        </div>
        {folder ? (
          <FolderFields f={f} set={set} />
        ) : rest ? (
          <RestFields f={f} set={set} />
        ) : (
        <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="Server" value={f.server} onChange={(e) => set({ server: e.target.value })} required placeholder={f.engine === "sqlserver" ? "SQL01" : "erp-db.factory.local"} hint="As the agent's machine knows it: a name or an address" />
          </div>
          {f.engine === "sqlserver" ? (
            <Field label="Instance" value={f.instance} onChange={(e) => set({ instance: e.target.value })} placeholder="SQLEXPRESS" hint="Or a port" />
          ) : (
            <Field label="Port" type="number" value={f.port} onChange={(e) => set({ port: e.target.value })} placeholder={f.engine === "mysql" ? "3306" : "5432"} />
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Database" value={f.database} onChange={(e) => set({ database: e.target.value })} required placeholder={f.engine === "sqlserver" ? "ERP" : "erp"} />
          {f.engine === "sqlserver" && <Field label="Port" type="number" value={f.port} onChange={(e) => set({ port: e.target.value })} placeholder="1433" hint="Only if not the default, and no instance" />}
        </div>
        <ComboField label="How the agent signs in" value={f.authType} onChange={(v) => v && set({ authType: v })} options={DB_AUTH[f.engine]} required />
        {f.authType === "windows" && (
          <p className="text-xs text-secondary-text">
            The agent signs in as its Windows service account. Give that account read access to the database (for example db_datareader on the schemas Fortress needs).
          </p>
        )}
        <div className="flex flex-col gap-2">
          <Switch checked={f.encrypt} onChange={(e) => set({ encrypt: e.target.checked })}>
            Encrypt the connection
          </Switch>
          {f.encrypt && (
            <Switch checked={f.trustServerCertificate} onChange={(e) => set({ trustServerCertificate: e.target.checked })}>
              Trust the server's certificate without checking it
            </Switch>
          )}
          {f.encrypt && f.trustServerCertificate && (
            <Callout tone="warning">Only for a server with a self-signed certificate on your own network: anyone between the agent and the database could read the traffic.</Callout>
          )}
        </div>
        </>
        )}
        {tried && problem && <p className="text-sm text-error-color" role="alert">{problem}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" loading={mutation.isPending} disabled={!existing && live.length === 0}>
            {existing ? "Save" : "Create connection"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default DatabaseConnectionDialog;
