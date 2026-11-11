import { useState } from "react";
import { Link } from "react-router-dom";
import { GraduationCapIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { useCompetenceCategories, useCompetenceMatrix, useCompetencePositions, useMatrixExport } from "../../hooks/useCompetence";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { downloadReport } from "../../lib/reportCsv";
import { useUrlFilters } from "../../hooks/useUrlFilters";
import { describeCell, MATRIX_STATUS_OPTIONS, matrixReport, statusClass } from "../../lib/competence";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import LoadingScreen from "../ui/LoadingScreen";
import SlidingToggle from "../ui/SlidingToggle";

export const MATRIX_FILTER_KEYS = ["search", "position", "category", "status", "page"];

/** A cell: the level (or a dash), tinted by how it stands against what the person's positions require. Title and label carry the words. */
const Cell = ({ cell, skill, person }) => (
  <td className="px-1 py-1 text-center">
    <span
      title={describeCell(cell)}
      aria-label={`${person}, ${skill}: ${describeCell(cell)}`}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-semibold ${cell.required === null && cell.level === null ? "text-tertiary-text" : statusClass(cell.status)}`}>
      {cell.level === null ? "–" : cell.level}
    </span>
  </td>
);

/**
 * The skills matrix (`/Competence/Matrix`): employees down the side, skills across the top. Each cell is a person's current level, coloured against what their
 * positions require (red below it or expired, amber not assessed or expiring, green on track, plain when nothing requires it). Filters live in the address.
 * A grid of a dynamic set of columns, so it is drawn directly rather than with the generic Table.
 */
const MatrixPage = () => {
  const f = useUrlFilters(MATRIX_FILTER_KEYS);
  const { showToast } = useToast();
  const exportMatrix = useMatrixExport();
  const [exporting, setExporting] = useState(false);
  const positions = useCompetencePositions();
  const categories = useCompetenceCategories();
  const matrix = useCompetenceMatrix({
    q: f.search, positionId: f.position, categoryId: f.category, status: f.status && f.status !== "all" ? f.status : undefined, page: f.page || undefined,
  });
  const page = Number(f.page) || 1;
  const filters = { q: f.search, positionId: f.position, categoryId: f.category, status: f.status && f.status !== "all" ? f.status : undefined };
  const exportCsv = async () => {
    setExporting(true);
    try {
      downloadReport(matrixReport(await exportMatrix(filters), { statusFilter: f.status || "all" }), "skills-matrix");
    } catch (err) {
      showToast({ type: "error", title: "Not exported", message: describeApiError(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex w-full min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <GraduationCapIcon className="h-7 w-7 text-primary-text" aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-semibold text-primary-text">Skills matrix</h1>
            <p className="text-sm text-secondary-text">Who can do what, against what their positions need. Open a person to assess them.</p>
          </div>
        </div>
        <CTAButton buttonType="button" type="secondary" onClick={exportCsv} disabled={exporting || !matrix.data?.data.length} loading={exporting}>
          Export CSV
        </CTAButton>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <SearchBox label="Search people" onSearch={(v) => f.updateFilters({ search: v })} />
        <div className="w-56">
          <ComboField label="Position" value={f.position || null} onChange={(v) => f.updateFilters({ position: v ?? "" })} options={(positions.data?.data ?? []).map((p) => ({ value: p.id, label: p.name }))} placeholder="Any position" />
        </div>
        <div className="w-56">
          <ComboField label="Category" value={f.category || null} onChange={(v) => f.updateFilters({ category: v ?? "" })} options={(categories.data?.data ?? []).map((c) => ({ value: c.id, label: c.label }))} placeholder="Every category" />
        </div>
        <SlidingToggle ariaLabel="Show" options={MATRIX_STATUS_OPTIONS} value={f.status || "all"} onChange={(v) => f.updateFilters({ status: v === "all" ? "" : v })} />
      </div>

      {matrix.isLoading ? (
        <LoadingScreen />
      ) : matrix.error ? (
        <ErrorNotice error={matrix.error} />
      ) : (
        <>
          {matrix.data.skillsTruncated && <Callout tone="info">Only the first {matrix.data.skills.length} skills are shown. Choose a category to narrow them.</Callout>}
          {matrix.data.employeesTruncated && <Callout tone="info">There are more people than can be shown at once. Search or choose a position to narrow them.</Callout>}
          {matrix.data.skills.length === 0 ? (
            <Callout tone="info" title="No skills to show">
              Set up skills and positions first, then give people positions.
            </Callout>
          ) : matrix.data.data.length === 0 ? (
            <p className="text-sm text-secondary-text">No one matches.</p>
          ) : (
            <div className="min-h-0 overflow-auto rounded-2xl border border-border-color bg-secondary-bg">
              <table className="min-w-full border-collapse text-sm" aria-label="Skills matrix">
                <thead>
                  <tr className="border-b border-border-color">
                    <th scope="col" className="sticky left-0 z-10 bg-secondary-bg px-3 py-2 text-left font-medium text-secondary-text">
                      Person
                    </th>
                    {matrix.data.skills.map((s) => (
                      <th key={s.id} scope="col" title={`${s.name} (${s.code})`} className="px-1 py-2 text-center text-xs font-medium text-secondary-text">
                        <span className="block max-w-24 truncate">{s.name}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.data.data.map((row) => (
                    <tr key={row.employee.id} className="border-b border-border-color last:border-0">
                      <th scope="row" className="sticky left-0 z-10 bg-secondary-bg px-3 py-1 text-left font-normal">
                        <Link to={`/Competence/People/${row.employee.id}`} className="font-medium text-primary-text hover:underline">
                          {row.employee.name}
                        </Link>
                        <span className="block text-xs text-secondary-text">{row.positions.map((p) => p.name).join(", ") || "No position"}</span>
                      </th>
                      {matrix.data.skills.map((s) => (
                        <Cell key={s.id} cell={row.cells[s.id]} skill={s.name} person={row.employee.name} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between text-sm text-secondary-text">
            <span>{matrix.data.total} {matrix.data.total === 1 ? "person" : "people"}</span>
            <div className="flex gap-2">
              <CTAButton type="neutral" disabled={page <= 1} onClick={() => f.updateFilters({ page: String(page - 1) })}>Previous</CTAButton>
              <CTAButton type="neutral" disabled={page * matrix.data.pageSize >= matrix.data.total} onClick={() => f.updateFilters({ page: String(page + 1) })}>Next</CTAButton>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default MatrixPage;
