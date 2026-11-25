export const csvEscape = (value) => {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // A leading = + - @ would be run as a formula by a spreadsheet: keep it as text.
  const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const csvLine = (cells) => cells.map(csvEscape).join(",");

/**
 * A report as CSV text: first what it is, the period, when it was worked out, what it was worked out with and what each column means, then a blank line and the table.
 * The preamble is part of the file on purpose: a report read later must say how it was made.
 */
export const reportToCsv = ({ meta, columns, rows }) => {
  const out = [
    csvLine(["Report", meta.title]),
    csvLine(["Period", `${meta.from} to ${meta.to}`]),
    csvLine(["Generated (UTC)", meta.generatedAt]),
    csvLine(["Rows", meta.rowCount]),
    ...meta.basis.map((b) => csvLine([b.label, b.value])),
    ...meta.definitions.map((d) => csvLine(["Definition", d])),
    "",
    csvLine(columns.map((c) => c.label)),
    ...rows.map((r) => csvLine(columns.map((c) => r[c.key]))),
  ];
  return out.join("\r\n") + "\r\n";
};

export const reportFilename = (meta, slug) => `${slug}-${meta.from}-to-${meta.to}.csv`;

export const downloadReport = (report, slug) => {
  const blob = new Blob([reportToCsv(report)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = reportFilename(report.meta, slug);
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
