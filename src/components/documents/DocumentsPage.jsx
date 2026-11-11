import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useDocuments, useDocumentTypes } from "../../hooks/useDocuments";
import { useUrlFilters } from "../../hooks/useUrlFilters";
import { contentKindLabel, DOCUMENT_STATUS, DOCUMENT_STATUS_OPTIONS, documentPath, REVISION_STATUS, statusLabel, statusPill } from "../../lib/documents";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import LoadingScreen from "../ui/LoadingScreen";
import SlidingToggle from "../ui/SlidingToggle";
import NewDocumentDialog from "./NewDocumentDialog";

const DOCUMENT_FILTER_KEYS = ["search", "status", "type", "kind", "owner", "sort", "order", "page"];

const COLUMNS = [
  ["number", "Number"],
  ["title", "Title"],
  ["type", "Type"],
  [null, "Content"],
  ["owner", "Owner"],
  [null, "In progress"],
  ["status", "Status"],
];

/** Documents (`/Documentation/Documents`): the register. Readers see documents once issued; drafts are seen by their author, owner and document managers. */
const DocumentsPage = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const f = useUrlFilters(DOCUMENT_FILTER_KEYS);
  const [creating, setCreating] = useState(false);
  const types = useDocumentTypes();
  const page = Number(f.page) || 1;
  const sort = f.sort || "number";
  const order = f.order || "asc";
  const docs = useDocuments({ q: f.search, status: f.status, type: f.type, kind: f.kind, owner: f.owner, sort, order, page: f.page || undefined });
  const typeOptions = (types.data?.data ?? []).map((t) => ({ value: t.id, label: t.name, hint: t.prefix }));

  const sortBy = (key) => f.updateFilters({ sort: key, order: sort === key && order === "asc" ? "desc" : "asc", page: "" });

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Documents</h1>
          <p className="text-sm text-secondary-text">Procedures, work instructions, forms and specifications, each with its revisions.</p>
        </div>
        {can("documentation.manage") && (
          <CTAButton buttonType="button" type="main" icon={PlusIcon} onClick={() => setCreating(true)}>
            New document
          </CTAButton>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <SearchBox label="Search documents" onSearch={(v) => f.updateFilters({ search: v, page: "" })} />
        <div className="w-56">
          <ComboField label="Type" value={f.type || null} onChange={(v) => f.updateFilters({ type: v ?? "", page: "" })} options={typeOptions} placeholder="Every type" clearable />
        </div>
        <div className="w-48">
          <ComboField
            label="Content"
            value={f.kind || null}
            onChange={(v) => f.updateFilters({ kind: v ?? "", page: "" })}
            options={[{ value: "text", label: "Written here" }, { value: "file", label: "A file" }]}
            placeholder="Either"
            clearable
          />
        </div>
        <SlidingToggle ariaLabel="Owner" options={[{ value: "", label: "Everyone's" }, { value: "me", label: "Mine" }]} value={f.owner || ""} onChange={(v) => f.updateFilters({ owner: v, page: "" })} />
      </div>
      <SlidingToggle ariaLabel="Status" options={DOCUMENT_STATUS_OPTIONS} value={f.status || ""} onChange={(v) => f.updateFilters({ status: v, page: "" })} />

      {docs.isLoading ? (
        <LoadingScreen />
      ) : docs.error ? (
        <ErrorNotice error={docs.error} />
      ) : docs.data.data.length === 0 ? (
        <p className="text-sm text-secondary-text">No documents {f.search || f.status || f.type || f.kind || f.owner ? "match" : "yet"}.</p>
      ) : (
        <div className="min-h-0 overflow-auto rounded-2xl border border-border-color bg-secondary-bg">
          <table className="min-w-full text-sm" aria-label="Documents">
            <thead>
              <tr className="border-b border-border-color text-left text-secondary-text">
                {COLUMNS.map(([key, label]) => (
                  <th key={label} scope="col" className="px-3 py-2 font-medium" aria-sort={key && sort === key ? (order === "asc" ? "ascending" : "descending") : undefined}>
                    {key ? (
                      <button type="button" onClick={() => sortBy(key)} className="hover:text-primary-text">
                        {label}
                        {sort === key ? (order === "asc" ? " ▲" : " ▼") : ""}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {docs.data.data.map((d) => (
                <tr key={d.id} className="border-b border-border-color last:border-0 hover:bg-primary-text/5">
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link to={documentPath(d.id)} className="font-medium text-primary-text hover:underline">
                      {d.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-primary-text">{d.title}</td>
                  <td className="px-3 py-2 text-secondary-text">{d.type.name}</td>
                  <td className="px-3 py-2 text-secondary-text">{contentKindLabel(d.contentKind)}</td>
                  <td className="px-3 py-2 text-secondary-text">{d.owner?.name ?? "—"}</td>
                  <td className="px-3 py-2 text-secondary-text">{d.inProgress ? statusLabel(REVISION_STATUS, d.inProgress.status) : "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(DOCUMENT_STATUS, d.status)}`}>{statusLabel(DOCUMENT_STATUS, d.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {docs.data && (
        <div className="flex items-center justify-between text-sm text-secondary-text">
          <span>
            {docs.data.total} {docs.data.total === 1 ? "document" : "documents"}
          </span>
          <div className="flex gap-2">
            <CTAButton type="neutral" disabled={page <= 1} onClick={() => f.updateFilters({ page: String(page - 1) })}>
              Previous
            </CTAButton>
            <CTAButton type="neutral" disabled={page * docs.data.pageSize >= docs.data.total} onClick={() => f.updateFilters({ page: String(page + 1) })}>
              Next
            </CTAButton>
          </div>
        </div>
      )}

      {creating && <NewDocumentDialog onClose={() => setCreating(false)} onCreated={(d) => d?.id && navigate(documentPath(d.id))} />}
    </div>
  );
};

export default DocumentsPage;
