import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../../../contexts/ToastProvider";
import { useAgentMutation } from "../../../hooks/useAgents";
import { useIntegrationMutation } from "../../../hooks/useIntegrations";
import { agentPath, ago } from "../../../lib/agents";
import { describeApiError } from "../../../lib/api-client";
import { AGENT_CREDENTIAL_WORDS, DB_ENGINES, agentJobRunning, databaseWhere, dbNeedsPassword, filePatternFrom, isFolderConfig } from "../../../lib/integrations";
import { formatDateTime } from "../../../lib/processControl";
import { sealCredential } from "../../../lib/sealCredential";
import { ServerIcon } from "@/components/icons";
import { Failed, JOB_STATUS, useAsk, Waiting } from "./agentAsk";
import { FileSourceDialog, RecordSourceDialog } from "./RecordSources";
import Callout from "../../ui/Callout";
import Dialog from "../../ui/Dialog";
import Field from "../../ui/Field";
import MenuCard from "../../ui/MenuCard";
import { FormError } from "../../master-data/shared";
import CTAButton from "@/components/CTAButton";

const JOB_WORDS = { store_credential: "Password", test_connection: "Connection test", discover: "Browse", preview: "Preview", extract: "Read for an import" };

/**
 * Type the database password. It is sealed here, in the browser, to the agent's own key (WebCrypto), so Fortress carries it without being able
 * to read it; the agent opens it and keeps it on its machine. It is never shown again.
 */
const PasswordDialog = ({ connection, onClose }) => {
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sealing, setSealing] = useState(false);
  const [error, setError] = useState(null);
  const ok = username.trim() && password;
  const save = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setError(null);
    setSealing(true);
    let sealed;
    try {
      sealed = await sealCredential(connection.agent.sealingKey, connection.id, { username: username.trim(), password });
    } catch (err) {
      setSealing(false);
      setError(err);
      return;
    }
    setSealing(false);
    setPassword("");
    mutation.mutate(
      { action: "setAgentCredential", id: connection.id, body: { keyId: connection.agent.keyId, sealed } },
      { onSuccess: () => onClose(), onError: (err) => showToast({ type: "error", title: "Not sent", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={connection.agentCredential ? "Change the database password" : "Type the database password"} onClose={onClose}>
      <form noValidate onSubmit={save} autoComplete="off" className="flex flex-col gap-3">
        <Callout tone="info">
          Sealed in your browser so that only the agent <strong>{connection.agent.name}</strong> can open it. Fortress passes it on without being able to read it,
          and it is never shown again. Use a login that can only read.
        </Callout>
        <Field label="User name" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" />
        <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
        {error && <p className="text-sm text-error-color" role="alert">{error.message}</p>}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ok} loading={sealing || mutation.isPending} loadingText={sealing ? "Sealing…" : "Sending…"}>
            Seal and send to the agent
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** The agent that reads this database, whether it is online, and whether it holds the password. Opening the page asks the agent to hurry. */
export const AgentCard = ({ connection: c, canManage }) => {
  const [typing, setTyping] = useState(false);
  const wakeMutation = useAgentMutation();
  const wake = wakeMutation.mutate;
  const agent = c.agent;
  const live = agent?.status === "active";
  useEffect(() => {
    if (agent?.id && live) wake({ action: "wake", id: agent.id });
  }, [agent?.id, live, wake]);
  if (!agent) return null;
  const needsPassword = dbNeedsPassword(c.config);
  const cred = c.agentCredential;
  const passwordJob = c.agentJobs?.find((j) => j.kind === "store_credential");
  return (
    <MenuCard title="Connector agent" subtitle={`${DB_ENGINES[c.config?.engine] ?? "Database"} at ${databaseWhere(c.config)}, read by an agent inside your network`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ServerIcon className="text-xl text-secondary-text" aria-hidden />
          <Link to={agentPath(agent.id)} className="text-sm font-medium text-link-color hover:underline">
            {agent.name}
          </Link>
          <span className={`text-xs ${!live ? "text-error-color" : agent.online ? "text-success-color" : "text-warning-color"}`}>
            {!live ? "Revoked" : agent.online ? "Online" : `Offline · last seen ${ago(agent.lastHeartbeatAt)}`}
          </span>
        </div>
        {needsPassword ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 text-sm text-primary-text">
              Password: {cred ? AGENT_CREDENTIAL_WORDS[cred.status] : "Not typed yet"}
              {cred?.status === "stored" && cred.storedAt ? ` · ${formatDateTime(cred.storedAt)}` : ""}
              {cred?.status === "waiting" && passwordJob && agentJobRunning(passwordJob.status) ? ` · ${JOB_STATUS[passwordJob.status]}` : ""}
            </span>
            {canManage && live && (
              <CTAButton type={cred?.status === "stored" ? "neutral" : "main"} size="md" onClick={() => setTyping(true)} disabled={!agent.sealingKey}>
                {cred && cred.status !== "cleared" ? "Change the password" : "Type the password"}
              </CTAButton>
            )}
          </div>
        ) : (
          <p className="text-sm text-secondary-text">
            {isFolderConfig(c.config)
              ? 'The agent reads the folder as its own Windows service account, so there is no password to type. Give that account read access to the folder, and add the folder to "folders" in the agent\'s allowlist.json.'
              : "Windows authentication: the agent signs in as its own service account, so there is no password to type."}
          </p>
        )}
        {(cred?.status === "failed" || cred?.status === "cleared") && cred.message && <Callout tone="warning">{cred.message}</Callout>}
        {live && !agent.online && <Callout tone="info">The agent is offline. Tests, browsing and passwords wait until it checks in again.</Callout>}
      </div>
      {typing && <PasswordDialog connection={c} onClose={() => setTyping(false)} />}
    </MenuCard>
  );
};

/** Ask the agent something and follow the job until it answers. */
const cell = (v) => (v === null || v === undefined ? <span className="text-secondary-text">—</span> : typeof v === "boolean" ? (v ? "true" : "false") : String(v));

/**
 * Browse the database as the agent sees it (after its login's rights and its local allow-list): schemas, then tables and views, then columns with
 * keys and the first rows. Every step is a job: the agent builds its own read-only query, Fortress sends no SQL.
 */
export const BrowseCard = ({ connection: c }) => (isFolderConfig(c.config) ? <FolderBrowseCard connection={c} /> : <DatabaseBrowseCard connection={c} />);

const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} bytes`);

/**
 * The files in a folder as the agent sees them (AG5b): only files directly in it, and only once the folder is on the agent's allow-list. A CSV or
 * Excel file can be previewed (the agent sends it and Fortress reads it) and used for a kind of record — by its name, or a pattern that picks the
 * newest of a series of dated exports.
 */
const FolderBrowseCard = ({ connection: c }) => {
  const files = useAsk(c.id);
  const preview = useAsk(c.id);
  const [previewing, setPreviewing] = useState(null);
  const [using, setUsing] = useState(null);
  if (c.agent?.status !== "active") return null;
  const done = (q) => q.job?.status === "completed";
  const list = done(files) ? files.job.result.files : [];
  return (
    <MenuCard
      title="Files in the folder"
      subtitle="What the agent can see in the folder. Fortress reads CSV and Excel files; nothing in the folder is changed."
      action={
        <CTAButton type="main" size="md" onClick={() => files.ask("discover", { level: "files" })} loading={files.busy} loadingText="Asking the agent…">
          {files.job ? "Look again" : "List the files"}
        </CTAButton>
      }>
      <div className="flex flex-col gap-4">
        {!files.job && !files.busy && <p className="text-sm text-secondary-text">List the files to choose the ones that hold your records.</p>}
        {files.busy && <Waiting job={files.job} />}
        {files.job?.status === "failed" && <Failed job={files.job} />}
        {done(files) && list.length === 0 && <p className="text-sm text-secondary-text">The folder is empty.</p>}
        {done(files) && list.length > 0 && (
          <ul aria-label="Files" className="flex flex-col divide-y divide-border-color">
            {list.map((f) => (
              <li key={f.name} className="flex flex-wrap items-center gap-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-primary-text">{f.name}</span>
                  <span className="text-xs text-secondary-text">
                    {size(f.size)}
                    {f.modifiedAt ? ` · changed ${formatDateTime(f.modifiedAt)}` : ""}
                    {f.supported ? "" : " · not a CSV or Excel file"}
                  </span>
                </div>
                {f.supported && (
                  <>
                    <CTAButton
                      type="secondary"
                      size="md"
                      aria-label={`Preview ${f.name}`}
                      loading={preview.busy && previewing === f.name}
                      onClick={() => {
                        setPreviewing(f.name);
                        preview.ask("preview", { file: f.name, limit: 20 });
                      }}>
                      Preview
                    </CTAButton>
                    <CTAButton type="main" size="md" aria-label={`Use ${f.name}`} onClick={() => setUsing(f.name)}>
                      Use this file
                    </CTAButton>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {files.job?.result?.truncated && <p className="text-xs text-secondary-text">Only the first 500 files are listed.</p>}
        {preview.busy && <Waiting job={preview.job} />}
        {preview.job?.status === "failed" && <Failed job={preview.job} />}
        {done(preview) && (
          <div className="overflow-x-auto rounded-xl border border-border-color">
            <table aria-label={`First rows of ${preview.job.result.file?.name ?? "the file"}`} className="min-w-full text-sm">
              <thead className="bg-secondary-bg text-left text-xs text-secondary-text">
                <tr>{preview.job.result.columns.map((col) => <th key={col.name} className="whitespace-nowrap px-2 py-1 font-medium">{col.name}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-border-color">
                {preview.job.result.rows.map((row, i) => (
                  <tr key={i}>{preview.job.result.columns.map((col) => <td key={col.name} className="whitespace-nowrap px-2 py-1 text-primary-text">{cell(row[col.name])}</td>)}</tr>
                ))}
              </tbody>
            </table>
            <p className="p-2 text-xs text-secondary-text">
              {preview.job.result.file?.name}: {(preview.job.result.rowCount ?? preview.job.result.rows.length).toLocaleString("en-GB")} rows
              {preview.job.result.sheet ? ` on the sheet ${preview.job.result.sheet}` : ""}
            </p>
          </div>
        )}
      </div>
      {using && <FileSourceDialog connection={c} initialName={filePatternFrom(using)} onClose={() => setUsing(null)} />}
    </MenuCard>
  );
};

const DatabaseBrowseCard = ({ connection: c }) => {
  const schemas = useAsk(c.id);
  const objects = useAsk(c.id);
  const columns = useAsk(c.id);
  const preview = useAsk(c.id);
  const [schema, setSchema] = useState(null);
  const [object, setObject] = useState(null);
  const [using, setUsing] = useState(false);
  if (c.agent?.status !== "active") return null;
  const pickSchema = (s) => {
    setSchema(s);
    setObject(null);
    columns.reset();
    preview.reset();
    objects.ask("discover", { level: "objects", schema: s });
  };
  const pickObject = (o) => {
    setObject(o);
    preview.reset();
    columns.ask("discover", { level: "columns", schema, object: o });
  };
  const done = (q) => q.job?.status === "completed";
  return (
    <MenuCard
      title="Browse the database"
      subtitle="What the agent can read with its sign-in and allow-list. Read only: Fortress never sends SQL."
      action={
        <CTAButton type="main" size="md" onClick={() => schemas.ask("discover", { level: "schemas" })} loading={schemas.busy} loadingText="Asking the agent…">
          {schemas.job ? "Look again" : "Browse"}
        </CTAButton>
      }>
      <div className="flex flex-col gap-4">
        {!schemas.job && !schemas.busy && <p className="text-sm text-secondary-text">Browse to see the schemas, tables and views the agent can read.</p>}
        {schemas.busy && <Waiting job={schemas.job} />}
        {schemas.job?.status === "failed" && <Failed job={schemas.job} />}
        {done(schemas) && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <section aria-label="Schemas" className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold uppercase text-secondary-text">Schemas</h4>
              {schemas.job.result.schemas.length === 0 && <p className="text-sm text-secondary-text">None this sign-in can read.</p>}
              {schemas.job.result.schemas.map((s) => (
                <button key={s.name} type="button" onClick={() => pickSchema(s.name)} aria-pressed={schema === s.name}
                  className={`rounded-lg px-2 py-1 text-left text-sm ${schema === s.name ? "bg-theme-light font-medium text-primary-text" : "text-primary-text hover:bg-secondary-bg"}`}>
                  {s.name}
                </button>
              ))}
              {schemas.job.result.allowListed && <p className="text-xs text-secondary-text">Limited by the agent's allow-list.</p>}
            </section>
            <section aria-label="Tables and views" className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold uppercase text-secondary-text">Tables and views</h4>
              {!schema && <p className="text-sm text-secondary-text">Choose a schema.</p>}
              {objects.busy && <Waiting job={objects.job} />}
              {objects.job?.status === "failed" && <Failed job={objects.job} />}
              {done(objects) &&
                objects.job.result.objects.map((o) => (
                  <button key={o.name} type="button" onClick={() => pickObject(o.name)} aria-pressed={object === o.name}
                    className={`flex justify-between gap-2 rounded-lg px-2 py-1 text-left text-sm ${object === o.name ? "bg-theme-light font-medium text-primary-text" : "text-primary-text hover:bg-secondary-bg"}`}>
                    <span>{o.name}</span>
                    <span className="text-xs text-secondary-text">{o.kind === "view" ? "view" : o.rowEstimate != null ? `~${o.rowEstimate.toLocaleString("en-GB")} rows` : "table"}</span>
                  </button>
                ))}
            </section>
            <section aria-label="Columns" className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold uppercase text-secondary-text">Columns</h4>
              {!object && <p className="text-sm text-secondary-text">Choose a table or view.</p>}
              {columns.busy && <Waiting job={columns.job} />}
              {columns.job?.status === "failed" && <Failed job={columns.job} />}
              {done(columns) && (
                <>
                  <ul className="flex flex-col gap-0.5 text-sm">
                    {columns.job.result.columns.map((col) => (
                      <li key={col.name} className="flex justify-between gap-2">
                        <span className="text-primary-text">
                          {col.name}
                          {col.primaryKey && <span className="ml-1 rounded bg-secondary-bg px-1 text-xs text-secondary-text">key</span>}
                        </span>
                        <span className="text-xs text-secondary-text">{col.type}{col.nullable ? "" : ", required"}</span>
                      </li>
                    ))}
                  </ul>
                  {columns.job.result.foreignKeys.length > 0 && (
                    <p className="text-xs text-secondary-text">
                      Links to: {columns.job.result.foreignKeys.map((f) => `${f.references.schema}.${f.references.object} (${f.columns.join(", ")})`).join("; ")}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <CTAButton type="secondary" size="md" onClick={() => preview.ask("preview", { schema, object, limit: 20 })} loading={preview.busy} loadingText="Reading…">
                      Preview the first rows
                    </CTAButton>
                    <CTAButton type="main" size="md" onClick={() => setUsing(true)}>Use this table</CTAButton>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
        {preview.busy && <Waiting job={preview.job} />}
        {preview.job?.status === "failed" && <Failed job={preview.job} />}
        {done(preview) && (
          <div className="overflow-x-auto rounded-xl border border-border-color">
            <table aria-label={`First rows of ${preview.job.result.schema}.${preview.job.result.object}`} className="min-w-full text-sm">
              <thead className="bg-secondary-bg text-left text-xs text-secondary-text">
                <tr>{preview.job.result.columns.map((col) => <th key={col.name} className="whitespace-nowrap px-2 py-1 font-medium">{col.name}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-border-color">
                {preview.job.result.rows.map((row, i) => (
                  <tr key={i}>{preview.job.result.columns.map((col) => <td key={col.name} className="whitespace-nowrap px-2 py-1 text-primary-text">{cell(row[col.name])}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {preview.job.result.rows.length === 0 && <p className="p-2 text-sm text-secondary-text">The table is empty.</p>}
          </div>
        )}
      </div>
      {using && done(columns) && (
        <RecordSourceDialog connection={c} schema={schema} object={object} shape={{ columns: columns.job.result.columns }} onClose={() => setUsing(false)} />
      )}
    </MenuCard>
  );
};

/** The latest things the agent was asked to do for this connection. */
export const AgentJobsList = ({ connection: c }) =>
  c.agentJobs?.length ? (
    <ul aria-label="Recent agent jobs" className="flex flex-col divide-y divide-border-color">
      {c.agentJobs.map((j) => (
        <li key={j.id} className="flex flex-wrap items-baseline gap-2 py-1.5 text-sm">
          <span className="font-medium text-primary-text">{JOB_WORDS[j.kind] ?? j.kind}</span>
          <span className={j.status === "failed" ? "text-error-color" : "text-secondary-text"}>{JOB_STATUS[j.status] ?? j.status}</span>
          {j.errorMessage && j.status !== "completed" && <span className="text-secondary-text">{j.errorMessage}</span>}
          <span className="ml-auto text-xs text-secondary-text">{formatDateTime(j.createdAt)}{j.requestedBy ? ` · ${j.requestedBy}` : ""}</span>
        </li>
      ))}
    </ul>
  ) : null;
