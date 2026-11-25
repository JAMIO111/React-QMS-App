import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, DownloadIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import { useFmeaRevision } from "../../hooks/useFmea";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { FORM_COLUMNS, downloadForm, effectLines, formFacts, formRows } from "../../lib/fmeaForm";
import { priorityLabel, revisionName, revisionPath } from "../../lib/fmea";

/** What a paper form shows, narrower than the CSV: the cells in the order of the form, with the repeated cells merged over the causes they belong to. */
const COLUMN_KEYS = ["path", "function", "mode", "effects", "severity", "cause", "prevention", "occurrence", "detectionControls", "detection", "rpn", "priority", "actions", "revisedRpn"];
const COLUMNS = COLUMN_KEYS.map((key) => FORM_COLUMNS.find((c) => c.key === key));
const MERGED_BY_FUNCTION = new Set(["path", "function"]);
const MERGED_BY_MODE = new Set(["mode", "effects", "severity"]);

const cellText = (column, row) => {
  const value = column.value(row);
  if (column.key === "revisedRpn" && value !== "") {
    const o = FORM_COLUMNS.find((c) => c.key === "revisedO").value(row);
    const d = FORM_COLUMNS.find((c) => c.key === "revisedD").value(row);
    return `${value} (O ${o}, D ${d})`;
  }
  return value;
};

/**
 * The FMEA as a form (`/FMEA/:id/revisions/:revisionId/report`): the analysis of one revision, one row for each cause, ready to print or save as PDF from the browser
 * (only the form is printed, landscape), and a CSV for a spreadsheet. The figures are the stored ones; nothing is worked out here.
 */
const FmeaFormPage = () => {
  const { id, revisionId } = useParams();
  const query = useFmeaRevision(revisionId);
  const revision = query.data;
  useBreadcrumbNames([
    { path: `/FMEA/${id}`, label: revision ? `${revision.fmea.number} · ${revision.fmea.title}` : null },
    { path: `/FMEA/${id}/revisions/${revisionId}`, label: revision ? revisionName(revision) : null },
    { path: `/FMEA/${id}/revisions/${revisionId}/report`, label: "Form" },
  ]);
  if (query.isLoading) return <p className="p-4 text-sm text-secondary-text">Loading…</p>;
  if (query.isError) return <Callout tone="error" role="alert">Could not load this FMEA.</Callout>;

  const rows = formRows(revision.net);
  const facts = formFacts(revision);
  const draft = revision.status === "draft";

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-y-auto p-4">
      <style>{"@page { size: landscape; margin: 10mm; } @media print { body * { visibility: hidden !important; } #fmea-form, #fmea-form * { visibility: visible !important; } #fmea-form { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; box-shadow: none; } }"}</style>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={revisionPath(id, revisionId)} className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
          <ArrowLeftIcon className="h-4 w-4" /> Back to the revision
        </Link>
        <div className="flex flex-wrap gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" icon={DownloadIcon} onClick={() => downloadForm(revision)}>
            Export CSV
          </CTAButton>
          <CTAButton buttonType="button" type="secondary" size="md" onClick={() => window.print()}>
            Print or save as PDF
          </CTAButton>
        </div>
      </div>

      <article id="fmea-form" aria-label="FMEA form" className="flex flex-col gap-3 rounded-xl bg-white p-6 text-sm text-black shadow">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">
            {revision.fmea.number} {revisionName(revision)} · {revision.fmea.title}
          </h1>
          {draft && <p className="font-semibold uppercase tracking-wide text-red-700">Draft: not in force, not for use</p>}
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {facts.map(([label, text]) => (
              <div key={label} className="flex gap-2">
                <dt className="w-28 shrink-0 font-medium text-gray-600">{label}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
        </header>

        {rows.length === 0 ? (
          <p className="italic text-gray-600">Nothing has been analysed yet.</p>
        ) : (
          <table className="w-full border-collapse text-left text-xs" aria-label="FMEA analysis">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c.key} scope="col" className="border border-gray-400 bg-gray-100 px-1.5 py-1 font-semibold">
                    {c.key === "revisedRpn" ? "Revised RPN" : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.cause?.id ?? row.mode?.id ?? row.fn.id}-${i}`} className="break-inside-avoid align-top">
                  {COLUMNS.map((c) => {
                    if (MERGED_BY_FUNCTION.has(c.key) && !row.fnSpan) return null;
                    if (MERGED_BY_MODE.has(c.key) && !row.modeSpan) return null;
                    const span = MERGED_BY_FUNCTION.has(c.key) ? row.fnSpan : MERGED_BY_MODE.has(c.key) ? row.modeSpan : 1;
                    const text = c.key === "priority" ? (row.cause?.priority ? priorityLabel(row.cause.priority) : "") : cellText(c, row);
                    return (
                      <td key={c.key} rowSpan={span > 1 ? span : undefined} className="border border-gray-400 px-1.5 py-1">
                        {c.key === "effects" ? (row.mode?.effects ?? []).map((e, n) => <span key={n} className="block">{effectLines([e])[0]}</span>) : text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>
    </div>
  );
};

export default FmeaFormPage;
