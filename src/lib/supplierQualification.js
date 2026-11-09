/** Supplier qualification records (certifications and documents): labels, expiry badges and small helpers. The database and API hold the rules. */

export const DOCUMENT_TYPES = [
  { id: "certificate", name: "Certificate" },
  { id: "quality_manual", name: "Quality manual" },
  { id: "questionnaire", name: "Questionnaire" },
  { id: "agreement", name: "Agreement" },
  { id: "insurance", name: "Insurance" },
  { id: "audit_report", name: "Audit report" },
  { id: "test_report", name: "Test report" },
  { id: "drawing_agreement", name: "Drawing agreement" },
  { id: "other", name: "Other" },
];
export const documentTypeLabel = (id) => DOCUMENT_TYPES.find((t) => t.id === id)?.name ?? id;

export const CERTIFICATION_TYPES = [
  { id: "iso_9001", name: "ISO 9001" },
  { id: "iatf_16949", name: "IATF 16949" },
  { id: "as9100", name: "AS9100" },
  { id: "iso_13485", name: "ISO 13485" },
  { id: "iso_14001", name: "ISO 14001" },
  { id: "iso_45001", name: "ISO 45001" },
  { id: "nadcap", name: "Nadcap" },
  { id: "rohs_reach", name: "RoHS / REACH" },
  { id: "other", name: "Other" },
];
export const certificationTypeLabel = (id) => CERTIFICATION_TYPES.find((t) => t.id === id)?.name ?? id;

/** The pill for an expiry state: words and an icon-free tone (the label carries the meaning). */
export const expiryBadge = (expiry) => {
  if (!expiry || expiry.state === "no_expiry") return { label: "No expiry", tone: "bg-border-color text-secondary-text" };
  if (expiry.state === "expired") {
    const n = Math.abs(expiry.daysLeft);
    return { label: n === 1 ? "Expired yesterday" : `Expired ${n} days ago`, tone: "bg-error-color/15 text-error-color" };
  }
  if (expiry.state === "expiring") {
    return { label: expiry.daysLeft === 0 ? "Expires today" : expiry.daysLeft === 1 ? "Expires tomorrow" : `Expires in ${expiry.daysLeft} days`, tone: "bg-warning-color/15 text-warning-color" };
  }
  return { label: "Valid", tone: "bg-success-color/15 text-success-color" };
};

export const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
