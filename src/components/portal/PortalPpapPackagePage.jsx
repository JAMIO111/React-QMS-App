import { useRef, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import { FormError, TextAreaField } from "../master-data/shared";
import { openPortalPpapPackageFile, usePortalPpapPackage, usePortalPpapPackageMutation, usePortalPpapPackages } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { PPAP_DECISION, PPAP_PACKAGE_STATUS, ppapPackagePath, shortDate } from "../../lib/portal";

const Fact = ({ label, value }) =>
  value === null || value === undefined || value === "" ? null : (
    <>
      <dt className="text-secondary-text">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-primary-text">{value}</dd>
    </>
  );

const sizeWords = (n) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

/** What to show beside a package: to prepare, submitted, or what we decided. */
const packagePill = (c) => {
  if (c.status === "pending") return PPAP_PACKAGE_STATUS.pending;
  if (PPAP_DECISION[c.submissionStatus]) return PPAP_DECISION[c.submissionStatus];
  return PPAP_PACKAGE_STATUS.answered;
};

/** The part approval packages the organisation has asked this supplier to prepare, as a list (the page and the dashboard). */
export function PpapPackageList({ access, onlyEditable = false, heading = "Part approval packages" }) {
  const packages = usePortalPpapPackages(access.organisationId, { enabled: access.partyKind === "supplier" });
  const items = (packages.data?.data ?? []).filter((c) => !onlyEditable || c.canEdit);
  if (access.partyKind !== "supplier" || packages.isLoading || items.length === 0) return null;
  return (
    <section aria-labelledby="portal-ppap-packages" className="flex flex-col gap-3 rounded-2xl border border-warning-color/40 bg-secondary-bg p-5">
      <div>
        <h2 id="portal-ppap-packages" className="text-lg font-semibold">{heading}</h2>
        <p className="text-sm text-secondary-text">{access.organisationName} asks you for these part approval packages.</p>
      </div>
      <ul aria-label={heading} className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
        {items.map((c) => {
          const pill = packagePill(c);
          return (
            <li key={c.id}>
              <Link to={ppapPackagePath(c.id, access.organisationId)} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-primary-bg">
                <span className="min-w-0 grow">
                  <span className="block truncate text-sm font-medium text-primary-text">{c.reference} · {c.partNumber} {c.partName}</span>
                  <span className="block text-xs text-secondary-text">Level {c.level} · asked {shortDate(c.requestedAt)}{c.answeredAt ? ` · submitted ${shortDate(c.answeredAt)}` : ""}</span>
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SubmitDialog({ pack, mutation, onClose }) {
  const [note, setNote] = useState("");
  return (
    <Dialog title={`Submit ${pack.reference}`} onClose={onClose}>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mutation.isPending) mutation.mutate({ action: "submit", note: note.trim() || null }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-secondary-text">Once you submit it you cannot add or take back files. {pack.reference ? "The team is told at once and will decide on it." : ""}</p>
        <TextAreaField label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} hint="Optional: anything we should know" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>Submit the package</CTAButton>
        </div>
      </form>
    </Dialog>
  );
}

function ElementFiles({ element, organisationId, mutation, canEdit }) {
  const input = useRef(null);
  const files = element.files ?? [];
  const adding = mutation.isPending && mutation.variables?.action === "add" && mutation.variables?.elementKey === element.key;
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 grow text-sm font-medium text-primary-text">{element.name}</span>
        <span className="text-xs text-secondary-text">{element.requirement}</span>
        <span className="text-xs font-medium text-primary-text">{element.waived ? "Waived" : element.provided ? "Provided" : "Not provided"}</span>
      </div>
      {files.length > 0 && (
        <ul aria-label={`Files for ${element.name}`} className="flex flex-col gap-1 text-sm">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2">
              <button type="button" className="min-w-0 truncate text-link-color hover:underline" onClick={() => openPortalPpapPackageFile(organisationId, f.id)}>{f.name}</button>
              <span className="text-xs text-secondary-text">{sizeWords(f.sizeBytes)}</span>
              {canEdit && <button type="button" aria-label={`Take back ${f.name}`} className="text-xs text-secondary-text hover:underline" onClick={() => mutation.mutate({ action: "remove", fileId: f.id })}>Take back</button>}
            </li>
          ))}
        </ul>
      )}
      {canEdit && !element.waived && (
        <div>
          <input
            ref={input}
            type="file"
            aria-label={`Choose a file for ${element.name}`}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) mutation.mutate({ action: "add", elementKey: element.key, file });
            }}
          />
          <CTAButton type="neutral" size="default" aria-label={`Add a file to ${element.name}`} loading={adding} loadingText="Uploading…" onClick={() => input.current?.click()}>Add a file</CTAButton>
        </div>
      )}
    </li>
  );
}

/** One package: what is asked of the supplier (named fields only), their own files per element, and the button to submit it. */
export default function PortalPpapPackagePage() {
  const { requestId } = useParams();
  const { access } = useOutletContext();
  const query = usePortalPpapPackage(access.organisationId, requestId);
  const mutation = usePortalPpapPackageMutation(access.organisationId, requestId);
  const [submitting, setSubmitting] = useState(false);
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) return <Callout tone="error" role="alert">{describeApiError(query.error)}</Callout>;
  const p = query.data;
  const pill = packagePill(p);
  return (
    <>
      <Link to="/portal/ppap-packages" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Back to part approvals
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{p.reference} · {p.partNumber} {p.partName}</h1>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.label}</span>
      </header>
      {p.requestNote && <Callout tone="info" title={`${access.organisationName} wrote`}>{p.requestNote}</Callout>}
      {p.decision === "rejected" && <Callout tone="error" title="Rejected">{p.decisionNote}</Callout>}
      {p.decision === "interim_approved" && <Callout tone="warning" title={`Approved for now${p.decisionExpiresOn ? ` until ${shortDate(p.decisionExpiresOn)}` : ""}`}>{p.decisionNote}</Callout>}
      {p.decision === "approved" && <Callout tone="success" title="Approved">{`Approved on ${shortDate(p.decidedOn)}.`}</Callout>}
      {p.status === "answered" && !p.decision && <Callout tone="info">You submitted this package on {shortDate(p.answeredAt)}. We will tell you what we decide.</Callout>}
      <section aria-label="The package" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 className="text-lg font-semibold">The package</h2>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">
          <Fact label="Part" value={`${p.partNumber} ${p.partName}`} />
          <Fact label="Revision" value={p.revision} />
          <Fact label="Level" value={p.level ? `Level ${p.level}` : null} />
          <Fact label="Reason" value={p.reason} />
          <Fact label="Asked on" value={shortDate(p.requestedAt)} />
          <Fact label="Submitted" value={p.submittedOn ? shortDate(p.submittedOn) : null} />
          <Fact label="Your contact" value={p.contact} />
        </dl>
      </section>
      <section aria-label="What we ask of you" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <h2 className="text-lg font-semibold">What we ask of you</h2>
        {p.canEdit && <p className="text-sm text-secondary-text">Add a file for each element marked Required. You can take your own files back until you submit.</p>}
        <ul aria-label="Elements" className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
          {p.elements.map((e) => (
            <ElementFiles key={e.key} element={e} organisationId={access.organisationId} mutation={mutation} canEdit={p.canEdit} />
          ))}
        </ul>
        {mutation.error && !submitting && <Callout tone="error" role="alert">{describeApiError(mutation.error)}</Callout>}
      </section>
      {p.canEdit && (
        <section aria-label="Submit" className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
          <h2 className="text-lg font-semibold">Submit</h2>
          {p.missing.length > 0 ? (
            <p className="text-sm text-secondary-text">Still needed before you can submit: {p.missing.join(", ")}.</p>
          ) : (
            <p className="text-sm text-secondary-text">Everything asked of you has a file. Check them, then submit.</p>
          )}
          <div>
            <CTAButton type="main" size="md" disabled={!p.canSubmit} onClick={() => setSubmitting(true)}>Submit the package</CTAButton>
          </div>
        </section>
      )}
      {submitting && <SubmitDialog pack={p} mutation={mutation} onClose={() => setSubmitting(false)} />}
    </>
  );
}
