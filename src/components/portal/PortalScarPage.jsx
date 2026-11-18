import { useRef, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { FormError, TextAreaField } from "../master-data/shared";
import { ArrowLeftIcon } from "@/components/icons";
import { openPortalScarFile, usePortalScar, usePortalScarMutation } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { todayIso } from "@/lib/localDate";
import { EXTENSION_WORDS, SCAR_SEVERITY, scarStatus, shortDate } from "../../lib/portal";
import { ROOT_CAUSE_METHODS, rootCauseMethodLabel } from "../../lib/supplierScars";

const day = (d) => (d ? shortDate(`${d}T12:00:00Z`) : "");
const dayAfter = (d) => new Date(new Date(`${d}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

const Fact = ({ label, value }) =>
  value === null || value === undefined || value === "" ? null : (
    <>
      <dt className="text-secondary-text">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-primary-text">{value}</dd>
    </>
  );
const Facts = ({ children }) => <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[11rem_1fr]">{children}</dl>;
const Block = ({ title, children }) => (
  <section aria-label={title} className="flex flex-col gap-2 rounded-2xl border border-border-color bg-secondary-bg p-5">
    <h2 className="text-lg font-semibold text-primary-text">{title}</h2>
    {children}
  </section>
);

const Back = () => (
  <Link to="/portal" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
    <ArrowLeftIcon className="h-4 w-4" /> Back to your portal
  </Link>
);

/** The shell of a portal dialog: a form, the server's refusal in words, Cancel and the main button. Nothing is sent until the form is valid. */
const FormDialog = ({ title, intro, width, ok, mutation, submitLabel, onClose, onSubmit, children }) => (
  <Dialog title={title} onClose={onClose} width={width}>
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !mutation.isPending) onSubmit();
      }}>
      {intro && <p className="text-sm text-secondary-text">{intro}</p>}
      {children}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={!ok || mutation.isPending} loading={mutation.isPending}>{submitLabel}</CTAButton>
      </div>
    </form>
  </Dialog>
);

function RespondDialog({ scar, mutation, onClose }) {
  const [rootCause, setRootCause] = useState("");
  const [method, setMethod] = useState(null);
  const [escape, setEscape] = useState("");
  const [extent, setExtent] = useState("");
  const [containment, setContainment] = useState("");
  const [corrective, setCorrective] = useState("");
  const [preventive, setPreventive] = useState("");
  const [planned, setPlanned] = useState("");
  const [responsible, setResponsible] = useState("");
  const ok = rootCause.trim().length >= 3 && corrective.trim().length >= 3;
  const body = () => ({
    rootCause: rootCause.trim(),
    correctiveAction: corrective.trim(),
    ...(containment.trim() ? { containment: containment.trim() } : {}),
    ...(preventive.trim() ? { preventiveAction: preventive.trim() } : {}),
    ...(planned ? { plannedCompletionOn: planned } : {}),
    ...(extent.trim() ? { extentOfCondition: extent.trim() } : {}),
    ...(escape.trim() ? { escapePoint: escape.trim() } : {}),
    ...(responsible.trim() ? { responsibleName: responsible.trim() } : {}),
    ...(method ? { rootCauseMethod: method } : {}),
  });
  return (
    <FormDialog
      title={scar.responses.length ? "Send a revised response" : "Respond to this request"}
      width="max-w-2xl"
      ok={ok}
      mutation={mutation}
      submitLabel="Send response"
      onClose={onClose}
      onSubmit={() => mutation.mutate({ action: "respond", body: body() }, { onSuccess: onClose })}
      intro="Your response goes to the organisation for review. Sending it does not close the request: we will accept it or ask for more.">
      <TextAreaField label="Root cause" required value={rootCause} onChange={(e) => setRootCause(e.target.value)} maxLength={4000} rows={3} />
      <ComboField label="How the root cause was found" value={method} onChange={setMethod} placeholder="Not stated" clearable options={ROOT_CAUSE_METHODS} />
      <TextAreaField label="Why it was not caught" value={escape} onChange={(e) => setEscape(e.target.value)} maxLength={4000} rows={2} hint="Why the problem reached the customer" />
      <TextAreaField label="Where else it could have happened" value={extent} onChange={(e) => setExtent(e.target.value)} maxLength={4000} rows={2} hint="Other lots, parts or customers" />
      <TextAreaField label="Containment" value={containment} onChange={(e) => setContainment(e.target.value)} maxLength={4000} rows={2} hint="What was done about product already made or shipped" />
      <TextAreaField label="Corrective action" required value={corrective} onChange={(e) => setCorrective(e.target.value)} maxLength={4000} rows={3} />
      <TextAreaField label="Preventive action" value={preventive} onChange={(e) => setPreventive(e.target.value)} maxLength={4000} rows={2} />
      <div className="grid gap-3 sm:grid-cols-2">
        <RHFDatePickerPopout label="Planned completion" valueFormat="iso" clearable value={planned} onChange={(v) => setPlanned(v ?? "")} minDate={todayIso()} placeholder="Not given" />
        <Field label="Responsible for the corrective action" value={responsible} onChange={(e) => setResponsible(e.target.value)} maxLength={200} placeholder="A name at your company" />
      </div>
    </FormDialog>
  );
}

function ExtendDialog({ scar, mutation, onClose }) {
  const [newDue, setNewDue] = useState("");
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      title="Ask for more time"
      ok={!!newDue && reason.trim().length >= 3}
      mutation={mutation}
      submitLabel="Ask for more time"
      onClose={onClose}
      onSubmit={() => mutation.mutate({ action: "extend", body: { newDueOn: newDue, reason: reason.trim() } }, { onSuccess: onClose })}
      intro={`The response is due ${day(scar.responseDueOn)}. The date does not change until someone at the organisation agrees.`}>
      <RHFDatePickerPopout label="New date" required valueFormat="iso" value={newDue} onChange={(v) => setNewDue(v ?? "")} minDate={dayAfter(scar.responseDueOn)} />
      <TextAreaField label="Why you need more time" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
    </FormDialog>
  );
}

function TakeBackDialog({ extension, mutation, onClose }) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      title="Take back your request"
      ok={reason.trim().length >= 3}
      mutation={mutation}
      submitLabel="Take it back"
      onClose={onClose}
      onSubmit={() => mutation.mutate({ action: "withdrawExtension", id: extension.id, body: { reason: reason.trim() } }, { onSuccess: onClose })}
      intro={`You asked for until ${day(extension.newDueOn)}. Taking it back leaves the date as it is.`}>
      <TextAreaField label="Why" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
    </FormDialog>
  );
}

const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);

/** Files sent with a response: each opens on a short link. */
const FileLinks = ({ files, label, organisationId }) =>
  !files?.length ? null : (
    <ul aria-label={label} className="flex flex-wrap gap-2">
      {files.map((f) => (
        <li key={f.id}>
          <button type="button" className="rounded-lg border border-border-color px-3 py-1.5 text-sm text-link-color hover:bg-primary-bg" onClick={() => openPortalScarFile(organisationId, f.id)}>
            {f.fileName} <span className="text-xs text-secondary-text">{size(f.sizeBytes)}</span>
          </button>
        </li>
      ))}
    </ul>
  );

/** Evidence waiting to be sent with the next response: add, take back. Shown while a response is awaited, or while files are waiting. */
function EvidenceBlock({ scar, mutation }) {
  const input = useRef(null);
  const uploading = mutation.isPending && mutation.variables?.action === "uploadFile";
  return (
    <Block title="Evidence to send with your response">
      <p className="text-sm text-secondary-text">Photos, reports or certificates that support your response. They are sent when you send the response; until then you can take them back. Up to ten files of 25 MB each.</p>
      {scar.draftFiles.length > 0 && (
        <ul aria-label="Files waiting to be sent" className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color">
          {scar.draftFiles.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 grow truncate text-primary-text">{f.fileName} <span className="text-xs text-secondary-text">{size(f.sizeBytes)}</span></span>
              <CTAButton type="neutral" size="default" aria-label={`Take back ${f.fileName}`} onClick={() => mutation.mutate({ action: "removeFile", id: f.id })}>Take back</CTAButton>
            </li>
          ))}
        </ul>
      )}
      {scar.canRespond && (
        <div>
          <input
            ref={input}
            type="file"
            aria-label="Choose a file to add"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) mutation.mutate({ action: "uploadFile", body: { file } });
            }}
          />
          <CTAButton type="secondary" size="md" loading={uploading} loadingText="Uploading…" onClick={() => input.current?.click()}>Add a file</CTAButton>
        </div>
      )}
    </Block>
  );
}

const ReviewNote = ({ review }) =>
  !review ? null : (
    <Callout tone={review.decision === "accepted" ? "success" : "warning"} title={review.decision === "accepted" ? "Accepted" : "A revision is needed"}>
      {review.note}
    </Callout>
  );

/**
 * One corrective action request as the supplier sees it (docs/external-portal-plan.md PT3a): what we asked, what is affected, what they have sent and
 * how we answered, and what they may do now. The database decides what is allowed (`canAcknowledge`, `canRespond`, `canRequestExtension`).
 */
export default function PortalScarPage() {
  const { scarId } = useParams();
  const { access } = useOutletContext();
  const query = usePortalScar(access.organisationId, scarId);
  const mutation = usePortalScarMutation(access.organisationId, scarId);
  const [dialog, setDialog] = useState(null);
  const close = () => {
    mutation.reset();
    setDialog(null);
  };

  if (access.mfaRequired) return null;
  if (query.isLoading) return <LoadingScreen />;
  if (query.error) {
    return (
      <>
        <Back />
        <Callout tone="error" role="alert">{query.error.status === 404 ? "This request is not available to you." : describeApiError(query.error)}</Callout>
      </>
    );
  }
  const s = query.data.scar;
  const st = scarStatus(s.status);
  const waiting = s.extensions.find((x) => x.status === "pending");

  return (
    <>
      <Back />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-primary-text">{s.reference} <span className="font-normal text-secondary-text">·</span> {s.title}</h1>
        <p className="text-sm text-secondary-text">
          Corrective action request · {SCAR_SEVERITY[s.severity]} · from {access.organisationName} · issued {shortDate(s.issuedAt)} · contact: {s.contact}
        </p>
      </header>

      <section aria-label="What to do next" className="flex flex-wrap items-center gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
        <div className="min-w-0 grow">
          <p className="text-lg font-semibold text-primary-text">{st.label}</p>
          {s.responseDueOn && ["issued", "acknowledged", "revision_requested"].includes(s.status) && (
            <p className={s.overdue ? "text-sm font-medium text-error-color" : "text-sm text-secondary-text"}>
              {s.overdue ? "Overdue: was due" : "Response due"} {day(s.responseDueOn)}
              {s.responseDueOn !== s.originalResponseDueOn && s.originalResponseDueOn ? ` (first asked for ${day(s.originalResponseDueOn)})` : ""}
            </p>
          )}
          {s.status === "cancelled" && s.cancelReason && <p className="text-sm text-secondary-text">{s.cancelReason}</p>}
        </div>
        {s.canAcknowledge && (
          <CTAButton type="secondary" size="md" loading={mutation.isPending && mutation.variables?.action === "acknowledge"} onClick={() => mutation.mutate({ action: "acknowledge" })}>
            Acknowledge we have it
          </CTAButton>
        )}
        {s.canRequestExtension && <CTAButton type="neutral" size="md" onClick={() => setDialog("extend")}>Ask for more time</CTAButton>}
        {s.canRespond && <CTAButton type="main" size="lg" onClick={() => setDialog("respond")}>{s.responses.length ? "Send a revised response" : "Respond"}</CTAButton>}
      </section>
      {mutation.error && !dialog && <Callout tone="error" role="alert">{describeApiError(mutation.error)}</Callout>}

      <Block title="What we are asking">
        <Facts>
          <Fact label="Problem" value={s.problemDescription} />
          <Fact label="Requirement not met" value={s.requirementBreached} />
          <Fact label="Evidence" value={s.objectiveEvidence} />
          <Fact label="Containment we need" value={s.containmentRequirements} />
        </Facts>
      </Block>

      <Block title="What is affected">
        {s.items.length === 0 ? <p className="text-sm text-secondary-text">Nothing has been listed.</p> : (
          <ul aria-label="Affected items" className="flex flex-col gap-2">
            {s.items.map((i, n) => (
              <li key={n} className="rounded-xl border border-border-color px-3 py-2 text-sm">
                <p className="text-primary-text">{[i.partNumber && `${i.partNumber}${i.partName ? ` · ${i.partName}` : ""}`, i.material, i.lotNumber && `Lot ${i.lotNumber}`, i.receiptReference && `Delivery ${i.receiptReference}`].filter(Boolean).join(" · ")}</p>
                <p className="text-xs text-secondary-text">{[i.quantity != null && `Quantity ${i.quantity}`, i.notes].filter(Boolean).join(" · ")}</p>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Your responses">
        {s.responses.length === 0 ? <p className="text-sm text-secondary-text">You have not responded yet.</p> : (
          <ol aria-label="Responses" className="flex flex-col gap-3">
            {s.responses.map((r) => (
              <li key={r.seq} className="flex flex-col gap-2 rounded-xl border border-border-color p-3">
                <p className="text-sm font-medium text-primary-text">Response {r.seq} · {day(r.respondedOn)}{r.respondedBy ? ` · ${r.respondedBy}` : ""}</p>
                <Facts>
                  <Fact label="Root cause" value={r.rootCause} />
                  <Fact label="Method" value={rootCauseMethodLabel(r.rootCauseMethod)} />
                  <Fact label="Why not caught" value={r.escapePoint} />
                  <Fact label="Where else" value={r.extentOfCondition} />
                  <Fact label="Containment" value={r.containment} />
                  <Fact label="Corrective action" value={r.correctiveAction} />
                  <Fact label="Preventive action" value={r.preventiveAction} />
                  <Fact label="Planned completion" value={day(r.plannedCompletionOn)} />
                  <Fact label="Responsible" value={r.responsibleName} />
                </Facts>
                <FileLinks files={r.files} label={`Files with response ${r.seq}`} organisationId={access.organisationId} />
                <ReviewNote review={r.review} />
              </li>
            ))}
          </ol>
        )}
      </Block>

      {(s.canRespond || s.draftFiles.length > 0) && <EvidenceBlock scar={s} mutation={mutation} />}

      {s.extensions.length > 0 && (
        <Block title="Requests for more time">
          <ul aria-label="Requests for more time" className="flex flex-col gap-2">
            {s.extensions.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border-color px-3 py-2 text-sm">
                <div className="min-w-0 grow">
                  <p className="text-primary-text">Until {day(x.newDueOn)} · {EXTENSION_WORDS[x.status] ?? x.status}</p>
                  <p className="text-xs text-secondary-text">{x.reason}{x.decisionNote ? ` · ${x.decisionNote}` : ""}</p>
                </div>
                {x.status === "pending" && x.mine && <CTAButton type="neutral" size="default" onClick={() => setDialog({ takeBack: x })}>Take back</CTAButton>}
              </li>
            ))}
          </ul>
          {waiting && !waiting.mine && <p className="text-xs text-secondary-text">A colleague asked for this. They can take it back.</p>}
        </Block>
      )}

      {dialog === "respond" && <RespondDialog scar={s} mutation={mutation} onClose={close} />}
      {dialog === "extend" && <ExtendDialog scar={s} mutation={mutation} onClose={close} />}
      {dialog?.takeBack && <TakeBackDialog extension={dialog.takeBack} mutation={mutation} onClose={close} />}
    </>
  );
}
