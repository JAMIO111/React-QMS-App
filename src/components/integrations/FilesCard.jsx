import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { uploadFileToSupabase } from "../../api/supabaseApi";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useIntegrationFiles, useIntegrationMutation } from "../../hooks/useIntegrations";
import { describeApiError } from "../../lib/api-client";
import { FILE_STATUS, fileProblem } from "../../lib/integrations";
import { formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";
import { FileIcon } from "../ui/FileDrop";
import MenuCard from "../ui/MenuCard";

const ACCEPT = ".csv,.txt,.xlsx";

export const FileStatusPill = ({ status }) => {
  const s = FILE_STATUS[status] ?? FILE_STATUS.uploaded;
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

/**
 * The Files card of a file connection: drop a CSV or Excel file (it goes to private storage, then the server reads it and keeps its rows), the files
 * uploaded so far, and "Map columns" for each one that could be read. Nothing is imported until a run is started.
 */
const FilesCard = ({ connection, canUpload, canMap }) => {
  const { organisationId } = useOrganisation();
  const files = useIntegrationFiles(connection.id);
  const mutation = useIntegrationMutation();
  const { showToast } = useToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const retired = connection.status === "retired";
  const list = files.data ?? [];

  const send = async (file) => {
    const problem = fileProblem(file);
    if (problem) return showToast({ type: "error", title: "Not uploaded", message: problem });
    setBusy(true);
    try {
      const { path } = await uploadFileToSupabase(file, "integration-files", organisationId, connection.id, "integration");
      const result = await mutation.mutateAsync({ action: "registerFile", id: connection.id, body: { path, fileName: file.name, size: file.size } });
      if (result.status === "failed") showToast({ type: "error", title: "The file could not be read", message: result.error });
      else showToast({ type: "success", title: "File read", message: `${result.rowCount} rows, ${result.headers.length} columns` });
    } catch (err) {
      showToast({ type: "error", title: "Not uploaded", message: describeApiError(err) });
    } finally {
      setBusy(false);
    }
  };
  const pick = (fl) => fl?.[0] && send(fl[0]);

  return (
    <MenuCard title="Files" subtitle="Upload a CSV or Excel (.xlsx) file, then map its columns to Fortress fields. Uploading imports nothing.">
      {canUpload && !retired && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload a file"
          onClick={() => !busy && input.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) pick(e.dataTransfer.files); }}
          className={`mb-3 flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm ${drag ? "border-theme bg-theme/5" : "border-border-color"} ${busy ? "opacity-60" : ""}`}>
          <span className="font-medium text-primary-text">{busy ? "Uploading and reading…" : "Drop a file here or click to choose one"}</span>
          <span className="text-xs text-secondary-text">.csv, .txt or .xlsx (first worksheet), up to 25 MB. The first row holds the column headings unless the connection says otherwise.</span>
          <input ref={input} type="file" accept={ACCEPT} className="hidden" data-testid="file-input" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        </div>
      )}
      {files.error ? (
        <Callout tone="error">{describeApiError(files.error)}</Callout>
      ) : list.length === 0 ? (
        <p className="text-sm text-secondary-text">No files uploaded yet.</p>
      ) : (
        <ul aria-label="Files" className="flex flex-col divide-y divide-border-color">
          {list.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 py-2">
              <FileIcon name={f.fileName} className="h-8 w-8" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-primary-text">{f.fileName}</span>
                <span className="text-xs text-secondary-text">
                  {f.status === "failed" ? f.error : `${f.rowCount} rows · ${f.headers.length} columns${f.sheet ? ` · sheet ${f.sheet}` : ""}`}
                  {" · "}{formatDateTime(f.uploadedAt)}{f.uploadedBy ? ` · ${f.uploadedBy.name}` : ""}
                </span>
              </div>
              <FileStatusPill status={f.status} />
              {f.status === "parsed" && (
                <Link to={`/Settings/Integrations/${connection.id}/mapping?file=${f.id}`} className="text-sm font-medium text-link-color hover:underline">
                  {canMap ? "Map columns" : "View columns"}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </MenuCard>
  );
};

export default FilesCard;
