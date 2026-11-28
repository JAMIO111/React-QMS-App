import { csvLine } from "./reportCsv";

export function exportCSV(data, filename = "export.csv") {
  if (!data || data.length === 0) {
    console.warn("No data to export");
    return;
  }

  const keys = Object.keys(data[0]);

  // Quoting and the spreadsheet formula guard (a cell starting = + - @ is kept as text) are shared with the reports.
  const csvRows = [csvLine(keys), ...data.map((row) => csvLine(keys.map((k) => row[k])))];
  // A byte-order mark so Excel reads accents and symbols as UTF-8; CRLF line ends as spreadsheets expect.
  const csvString = `\uFEFF${csvRows.join("\r\n")}\r\n`;

  // Create blob and download link
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}
