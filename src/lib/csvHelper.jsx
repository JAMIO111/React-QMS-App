export function exportCSV(data, filename = "export.csv") {
  if (!data || data.length === 0) {
    console.warn("No data to export");
    return;
  }

  const keys = Object.keys(data[0]);

  // Helper to escape CSV fields (handle commas, quotes, new lines)
  const escapeCSV = (value) => {
    if (value == null) return "";
    const stringValue = value.toString();
    if (/[",\n]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  // Generate CSV header row
  const csvRows = [keys.join(",")];

  // Generate CSV data rows
  for (const row of data) {
    const values = keys.map((k) => escapeCSV(row[k]));
    csvRows.push(values.join(","));
  }

  const csvString = csvRows.join("\n");

  // Create blob and download link
  const blob = new Blob([csvString], { type: "text/csv" });
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
