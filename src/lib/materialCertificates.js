/** Shared definitions for material certificates (SQ4c). */
export const CERT_KINDS = [
  { value: "mill_test_report", label: "Mill test report" },
  { value: "certificate_of_conformance", label: "Certificate of conformance" },
  { value: "certificate_of_analysis", label: "Certificate of analysis" },
  { value: "test_report", label: "Test report" },
  { value: "other", label: "Other" },
];
export const certKindLabel = (v) => CERT_KINDS.find((k) => k.value === v)?.label ?? v;

export const CERT_STATUS = {
  received: { label: "Waiting for review", tone: "bg-warning-color/20 text-primary-text" },
  accepted: { label: "Accepted", tone: "bg-success-color/15 text-success-color" },
  rejected: { label: "Rejected", tone: "bg-error-color/15 text-error-color" },
  withdrawn: { label: "Withdrawn", tone: "bg-border-color text-secondary-text" },
};

export const CERT_FILTERS = [
  { value: "live", label: "Current" },
  { value: "review", label: "To review" },
  { value: "all", label: "All" },
];

export const CERTIFICATES_PATH = "/Supplier-Quality/Material-Certificates";

/** What a line has on file, in words. */
export const certificateSummary = (c) => {
  if (!c) return "No certificates";
  const parts = [c.accepted && `${c.accepted} accepted`, c.received && `${c.received} to review`, c.rejected && `${c.rejected} rejected`].filter(Boolean);
  return parts.length ? parts.join(", ") : "No certificates";
};
