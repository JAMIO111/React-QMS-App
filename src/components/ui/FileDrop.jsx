import { useEffect, useRef, useState } from "react";
import { CloudUploadIcon, RotateCcwIcon, SaveIcon, Trash2Icon, Undo2Icon, XIcon } from "@/components/icons";
import { uploadFileToSupabase } from "@/api/supabaseApi";
import CTAButton from "../CTAButton";
import DownloadLink from "./DownloadLink";
import ReasonDialog from "../ncr/ReasonDialog";
import { useToast } from "@/contexts/ToastProvider";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useNcrAttachments, useNcrMutation } from "../../hooks/useNcr";
import { apiFetch, describeApiError } from "../../lib/api-client";

/** Largest file the database accepts (ncr_attachments.size_bytes). */
const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const formatBytes = (bytes, decimals = 1) => {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
};

const ICONS = {
  pdf: ["/icons/pdf-icon.svg", "PDF"],
  doc: ["/icons/word-icon.png", "Word"], docx: ["/icons/word-icon.png", "Word"],
  xls: ["/icons/excel-icon.png", "Excel"], xlsx: ["/icons/excel-icon.png", "Excel"], csv: ["/icons/excel-icon.png", "Excel"],
  ppt: ["/icons/ppt-icon.png", "PowerPoint"], pptx: ["/icons/ppt-icon.png", "PowerPoint"],
};
const FileIcon = ({ name, type }) => {
  const ext = name.split(".").pop()?.toLowerCase();
  const [main] = (type || "").split("/");
  const [src, alt] = ICONS[ext] ?? (main === "video" ? ["/icons/video-icon.png", "Video"] : main === "audio" ? ["/icons/audio-icon.png", "Audio"] : ["/icons/file-icon.png", "File"]);
  return <img src={src} alt={alt} className="h-10 w-10" />;
};

/**
 * Drag-and-drop attachments for a record (ported from the original NC FileDrop). New files are
 * listed as unsaved until "Save uploads": each is uploaded to a private bucket at
 * <org>/<folder>/<record id>/… and then recorded through the API (POST `attachUrl`). Removing a
 * saved file asks for a reason and keeps the stored file as evidence (it can be restored through
 * `${itemBase}/<id>/delete|restore`).
 */
export const AttachmentDrop = ({ recordId, bucket, folder, attachments, mutation, attachUrl, itemBase, title = "File upload", subtitle, canEdit = true }) => {
  const [dragActive, setDragActive] = useState(false);
  const [newFiles, setNewFiles] = useState([]); // [{ file, previewUrl }]
  const [isSaving, setIsSaving] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const fileInputRef = useRef(null);
  const { showToast } = useToast();
  const { organisationId } = useOrganisation();
  const saved = attachments.data ?? [];

  useEffect(() => () => newFiles.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)), [newFiles]);

  const addFiles = (files) => {
    const valid = [];
    Array.from(files).forEach((file) => {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        showToast({ type: "error", title: "File too large", message: `"${file.name}" is over ${MAX_FILE_SIZE_MB} MB and was not added.` });
        return;
      }
      const duplicate = newFiles.some((f) => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified);
      if (!duplicate) valid.push({ file, previewUrl: file.type?.startsWith("image/") ? URL.createObjectURL(file) : null });
    });
    if (valid.length) setNewFiles((prev) => [...prev, ...valid]);
  };

  const discard = (entry) => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    setNewFiles((prev) => prev.filter((f) => f !== entry));
  };

  const handleSave = async () => {
    setIsSaving(true);
    let uploaded = 0;
    const failed = [];
    for (const entry of newFiles) {
      try {
        const { path } = await uploadFileToSupabase(entry.file, bucket, organisationId, recordId, folder);
        await apiFetch(attachUrl, {
          method: "POST",
          organisationId,
          body: { storagePath: path, fileName: entry.file.name, contentType: entry.file.type || null, sizeBytes: entry.file.size },
        });
        uploaded++;
      } catch (err) {
        failed.push(entry);
        showToast({ type: "error", title: "Upload failed", message: `"${entry.file.name}": ${describeApiError(err)}` });
      }
    }
    setNewFiles(failed);
    setIsSaving(false);
    await attachments.refetch();
    if (uploaded) showToast({ type: "success", title: "Uploaded", message: `${uploaded} ${uploaded === 1 ? "file" : "files"} attached.` });
  };

  const onDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(e.type === "dragenter" || e.type === "dragover");
  };
  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (canEdit && e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  };

  const visibleSaved = saved.filter((f) => showRemoved || !f.deletedAt);
  const rows = [...newFiles.map((entry) => ({ entry })), ...visibleSaved.map((file) => ({ file }))];

  return (
    <div className="flex h-full w-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-xl font-semibold text-primary-text">{title}</h3>
        {subtitle && <p className="text-sm text-secondary-text">{subtitle}</p>}
      </div>
      {canEdit && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Add files: drag and drop here or press to choose"
          onDragEnter={onDrag}
          onDragOver={onDrag}
          onDragLeave={onDrag}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileInputRef.current?.click())}
          className={`flex w-full cursor-pointer flex-col items-center justify-center gap-5 rounded-xl border-2 border-dashed p-4 py-10 transition-colors ${
            dragActive ? "border-brand-primary bg-brand-primary/10" : "border-border-dark-color bg-secondary-bg hover:bg-primary-text/5"
          }`}>
          <CloudUploadIcon className="h-18 w-18 text-primary-text" />
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="text-lg text-primary-text">Drag and drop files here or click to select</span>
            <span className="text-secondary-text">(Max file size {MAX_FILE_SIZE_MB} MB)</span>
          </div>
          <input
            type="file"
            data-testid="file-input"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
            ref={fileInputRef}
            hidden
            multiple
          />
        </div>
      )}

      <div className="flex w-full flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-lg text-primary-text">Files & attachments</h4>
          <div className="flex items-center gap-3">
            {saved.some((f) => f.deletedAt) && (
              <label className="flex items-center gap-2 text-sm text-secondary-text">
                <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
                Show removed
              </label>
            )}
            {newFiles.length > 0 && (
              <>
                <CTAButton text="Discard" type="neutral" icon={Undo2Icon} callbackFn={() => setNewFiles([])} disabled={isSaving} />
                <CTAButton
                  icon={SaveIcon}
                  iconSize="h-4 w-4"
                  text={isSaving ? "Saving…" : newFiles.length === 1 ? "Save upload" : `Save ${newFiles.length} uploads`}
                  disabled={isSaving}
                  type="success"
                  callbackFn={handleSave}
                />
              </>
            )}
          </div>
        </div>

        {attachments.isLoading ? (
          <p className="rounded-lg border-2 border-dashed border-border-dark-color bg-secondary-bg p-4 text-center text-secondary-text">Loading files…</p>
        ) : attachments.error ? (
          <p role="alert" className="rounded-lg border-2 border-dashed border-border-dark-color bg-secondary-bg p-4 text-center text-error-color">
            {describeApiError(attachments.error)}
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border-2 border-dashed border-border-dark-color bg-secondary-bg p-4 text-center text-muted">No files attached yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border-2 border-dashed border-border-dark-color">
            <table className="w-full table-auto text-left text-sm text-secondary-text" aria-label="Attached files">
              <thead className="bg-primary-bg text-primary-text">
                <tr>
                  <th className="px-2 py-2 text-center">Preview</th>
                  <th className="px-4 py-2">File name</th>
                  <th className="px-4 py-2">Size</th>
                  <th className="px-4 py-2">Uploaded by</th>
                  <th className="w-10 px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ entry, file }) => {
                  const name = entry ? entry.file.name : file.fileName;
                  const type = entry ? entry.file.type : file.contentType;
                  return (
                    <tr key={entry ? `new-${name}-${entry.file.lastModified}-${entry.file.size}` : file.id}
                      className={`border-t border-border-color hover:bg-primary-text/5 ${file?.deletedAt ? "opacity-60" : ""}`}>
                      <td>
                        <div className="flex items-center justify-center p-2">
                          {entry?.previewUrl ? (
                            <img src={entry.previewUrl} alt={name} className="h-16 w-16 rounded-md object-cover" />
                          ) : type?.startsWith("image/") ? (
                            <img src="/icons/image-icon.png" alt="Image" className="h-10 w-10" />
                          ) : (
                            <FileIcon name={name} type={type} />
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-col items-start gap-1.5">
                          <span className="text-primary-text">{name}</span>
                          {entry && <span className="rounded-md border border-warning-color bg-warning-color/60 px-1.5 py-0.5 text-xs italic text-gray-900">Unsaved file</span>}
                          {file?.deletedAt && <span className="text-xs text-error-color">Removed: {file.deleteReason}</span>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">{formatBytes(entry ? entry.file.size : file.sizeBytes)}</td>
                      <td className="px-4 py-2">
                        {file ? (
                          <div className="flex flex-col gap-1">
                            <span>{file.createdBy?.name ?? "—"}</span>
                            <span className="text-xs">{new Date(file.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
                          </div>
                        ) : (
                          "You"
                        )}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <div className="flex items-center justify-center gap-3">
                          {entry ? (
                            <button type="button" aria-label={`Discard ${name}`} title="Discard" onClick={() => discard(entry)} className="rounded-lg p-1.5 text-error-color hover:bg-secondary-text/5 cursor-pointer">
                              <XIcon className="h-5 w-5" />
                            </button>
                          ) : (
                            <>
                              <DownloadLink bucket={bucket} file={{ id: file.id, path: file.storagePath, name }} />
                              {canEdit && !file.deletedAt && (
                                <button type="button" aria-label={`Remove ${name}`} title="Remove" onClick={() => { mutation.reset(); setRemoving(file); }}
                                  className="rounded-lg p-1.5 text-error-color hover:bg-secondary-text/5 cursor-pointer">
                                  <Trash2Icon className="h-5 w-5" />
                                </button>
                              )}
                              {canEdit && file.deletedAt && (
                                <button type="button" aria-label={`Restore ${name}`} title="Restore"
                                  onClick={() => mutation.mutate({ path: `${itemBase}/${file.id}/restore` }, { onError: (e) => showToast({ type: "error", title: "Not restored", message: describeApiError(e) }) })}
                                  className="rounded-lg p-1.5 text-primary-text hover:bg-secondary-text/5 cursor-pointer">
                                  <RotateCcwIcon className="h-5 w-5" />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {removing && (
        <ReasonDialog
          title={`Remove ${removing.fileName}?`}
          label="Reason for removing"
          confirmText="Remove"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setRemoving(null)}
          onConfirm={(reason) =>
            mutation.mutate(
              { path: `${itemBase}/${removing.id}/delete`, body: { reason } },
              {
                onSuccess: () => {
                  showToast({ type: "success", title: "Removed", message: `${removing.fileName} was removed. It can be restored with “Show removed”.` });
                  setRemoving(null);
                },
              }
            )
          }
        />
      )}
    </div>
  );
};

/** Photos, reports and other evidence for a non-conformance (nc-files bucket). */
const FileDrop = ({ ncrId, canEdit = true }) => {
  const attachments = useNcrAttachments(ncrId);
  const mutation = useNcrMutation();
  return (
    <AttachmentDrop
      recordId={ncrId}
      bucket="nc-files"
      folder="ncr"
      attachments={attachments}
      mutation={mutation}
      attachUrl={`/ncrs/${ncrId}/attachments`}
      itemBase="/ncr-attachments"
      subtitle="Photos, reports and other evidence for this non-conformance."
      canEdit={canEdit}
    />
  );
};

export default FileDrop;
