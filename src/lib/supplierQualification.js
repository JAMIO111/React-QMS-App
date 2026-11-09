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

export const ANSWER_TYPES = [
  { id: "yes_no", name: "Yes / no" },
  { id: "rating", name: "Rating 1 to 5" },
  { id: "text", name: "A note" },
];

export const ASSESSMENT_STATUS = {
  in_progress: { label: "In progress", tone: "bg-warning-color/15 text-warning-color" },
  completed: { label: "Completed", tone: "bg-success-color/15 text-success-color" },
  abandoned: { label: "Abandoned", tone: "bg-border-color text-secondary-text" },
};
export const RESULT_TONE = { pass: "bg-success-color/15 text-success-color", fail: "bg-error-color/15 text-error-color" };

export const DECISION_STATUS = {
  proposed: { label: "Waiting for a decision", tone: "bg-warning-color/15 text-warning-color" },
  approved: { label: "Approved", tone: "bg-success-color/15 text-success-color" },
  rejected: { label: "Rejected", tone: "bg-error-color/15 text-error-color" },
  withdrawn: { label: "Withdrawn", tone: "bg-border-color text-secondary-text" },
};

/** A stable question key from its wording (lower-case words, 2 to 40 characters, unique among `taken`). */
export const questionKey = (text, taken = []) => {
  const base = (text || "question").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").split("_").slice(0, 5).join("_").slice(0, 36) || "question";
  let key = base.length < 2 ? `${base}_q` : base;
  for (let n = 2; taken.includes(key); n += 1) key = `${base}_${n}`.slice(0, 40);
  return key;
};
