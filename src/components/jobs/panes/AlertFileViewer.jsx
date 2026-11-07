import { useQuery } from "@tanstack/react-query";
import { generateSignedUrl } from "../../../api/supabaseApi";
import { FileTextIcon } from "@/components/icons";
import DownloadLink from "../../ui/DownloadLink";

const BUCKET = "quality-alert-files";
const size = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** An image on an alert, shown in the pane through a short-lived signed link (the bucket is private). Click for full size in a new tab. */
const Picture = ({ file }) => {
  const url = useQuery({ queryKey: ["signed-url", BUCKET, file.storagePath], queryFn: () => generateSignedUrl(BUCKET, file.storagePath, 60 * 30), staleTime: 20 * 60_000, retry: false });
  if (url.isLoading) return <div role="status" aria-label={`Loading ${file.fileName}`} className="h-40 w-full rounded-lg shimmer" />;
  if (!url.data) return <p className="text-sm text-error-color">{file.fileName} could not be loaded.</p>;
  return (
    <a href={url.data} target="_blank" rel="noopener noreferrer" className="block">
      <img src={url.data} alt={file.fileName} className="w-full rounded-lg border border-border-color object-contain" />
    </a>
  );
};

/** The files on an alert: pictures inline, other documents (PDFs, certificates) opened in a new tab. Removed files are not shown. */
const AlertFileViewer = ({ files }) => {
  const live = (files ?? []).filter((f) => !f.deletedAt);
  if (live.length === 0) return null;
  return (
    <section aria-label="Alert files" className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-text">Files ({live.length})</h3>
      <ul className="flex flex-col gap-2">
        {live.map((f) => (
          <li key={f.id} className="flex flex-col gap-1">
            {f.contentType?.startsWith("image/") ? (
              <Picture file={f} />
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-border-color p-2">
                <FileTextIcon className="h-5 w-5 shrink-0 text-secondary-text" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm text-primary-text">{f.fileName}</span>
                <span className="text-xs text-secondary-text">{size(f.sizeBytes)}</span>
                <DownloadLink bucket={BUCKET} file={{ id: f.id, path: f.storagePath, name: f.fileName }} />
              </div>
            )}
            {f.contentType?.startsWith("image/") && <span className="text-xs text-secondary-text">{f.fileName}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
};

export default AlertFileViewer;
