import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import CTAButton from "@/components/CTAButton";
import { generateSignedUrl, uploadFileToSupabase } from "../../api/supabaseApi";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { usePpapMutation } from "../../hooks/usePpap";
import { describeApiError } from "../../lib/api-client";
import { todayIso } from "../../lib/localDate";
import {
  DECISION_CHOICES, REASONS, RESULTS_CHOICES, WEIGHT_UNITS, decisionLabel, decisionPill, fileSizeLabel, formatDay, levelLabel, ppapPath, pswPath, resultsValue,
} from "../../lib/ppap";
import { FormError, TextAreaField } from "../master-data/shared";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import TextInput from "../ui/TextInput";

/** The warrant, sending the submission and what the customer decided (PP3). The database decides every move; these pieces ask and show what it answers. */

const Buttons = ({ onClose, pending, disabled, label, type = "main" }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type={type} size="md" disabled={disabled || pending} loading={pending}>
      {label}
    </CTAButton>
  </div>
);

const Fact = ({ label, children }) => (
  <div>
    <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">{label}</dt>
    <dd className="whitespace-pre-wrap text-sm text-primary-text">{children}</dd>
  </div>
);

// ---- the warrant ----------------------------------------------------------------------------------------

/** The typed fields, saved together; the rest of the warrant is the submission itself (see the form). Remounted whenever the submission changes, so it shows what was saved. */
const PswFields = ({ ppap, mutation }) => {
  const psw = ppap.psw;
  const { showToast } = useToast();
  const [weight, setWeight] = useState(psw?.partWeight == null ? "" : String(psw.partWeight));
  const [unit, setUnit] = useState(psw?.weightUnit ?? "kg");
  const [purchaseOrder, setPurchaseOrder] = useState(psw?.purchaseOrder ?? "");
  const [ecLevel, setEcLevel] = useState(psw?.engineeringChangeLevel ?? "");
  const [results, setResults] = useState(resultsValue(psw?.resultsMeetRequirements));
  const [declaration, setDeclaration] = useState(psw?.declaration ?? "");
  const bad = weight.trim() !== "" && !(Number(weight) > 0);

  const save = (e) => {
    e.preventDefault();
    if (bad) return;
    const body = {
      partWeight: weight.trim() === "" ? null : Number(weight),
      ...(weight.trim() === "" ? {} : { weightUnit: unit }),
      purchaseOrder: purchaseOrder.trim() || null,
      engineeringChangeLevel: ecLevel.trim() || null,
      resultsMeetRequirements: results === "" ? null : results === "yes",
      declaration: declaration.trim() || null,
    };
    mutation.mutate({ action: "savePsw", id: ppap.id, body }, { onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  };

  return (
    <form noValidate onSubmit={save} className="flex flex-col gap-3 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <TextInput label="Part weight" required inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} error={bad ? "A number above zero" : undefined} />
        <ComboField label="Unit" value={unit} onChange={(v) => setUnit(v ?? "kg")} options={WEIGHT_UNITS} clearable={false} sort={false} />
        <TextInput label="Purchase order" value={purchaseOrder} onChange={(e) => setPurchaseOrder(e.target.value)} maxLength={100} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label="Engineering change level" value={ecLevel} onChange={(e) => setEcLevel(e.target.value)} maxLength={100} />
        <ComboField label="Do the results meet all the requirements" required value={results} onChange={(v) => setResults(v ?? "")} options={RESULTS_CHOICES} clearable={false} sort={false} />
      </div>
      <TextAreaField
        label={results === "no" ? "What does not meet the requirements" : "Declaration or explanation"}
        required={results === "no"}
        value={declaration}
        onChange={(e) => setDeclaration(e.target.value)}
        rows={3}
        maxLength={2000}
      />
      <div className="flex justify-end">
        <CTAButton buttonType="submit" type="main" size="md" disabled={bad} loading={mutation.isPending && mutation.variables?.action === "savePsw"}>
          Save the warrant
        </CTAButton>
      </div>
    </form>
  );
};

const SignDialog = ({ ppap, onClose }) => {
  const mutation = usePpapMutation();
  const { showToast } = useToast();
  const [title, setTitle] = useState("");
  const [phone, setPhone] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    mutation.mutate(
      { action: "signPsw", id: ppap.id, body: { title: title.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not signed", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title="Sign the Part Submission Warrant" onClose={onClose} width="max-w-lg">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Your name comes from your profile. Signing locks the typed fields until an approver takes the signature off.</p>
        <TextInput label="Your title" required value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
        <TextInput label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={50} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!title.trim()} label="Sign" />
      </form>
    </Dialog>
  );
};

const ReasonForm = ({ title, label, submitLabel, tone, minLength = 3, onSubmit, pending, error, onClose }) => {
  const [reason, setReason] = useState("");
  const valid = reason.trim().length >= minLength;
  return (
    <Dialog title={title} onClose={onClose} width="max-w-lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(reason.trim());
        }}
        className="flex flex-col gap-3"
      >
        <TextAreaField label={label} required value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} hint={`At least ${minLength} characters`} />
        <FormError error={error} />
        <Buttons onClose={onClose} pending={pending} disabled={!valid} label={submitLabel} type={tone} />
      </form>
    </Dialog>
  );
};

/** The Part Submission Warrant: the fields typed by the preparer, who may sign it (never the preparer) and the signature. */
export const PswCard = ({ ppap }) => {
  const mutation = usePpapMutation();
  const [dialog, setDialog] = useState(null);
  const psw = ppap.psw;
  const element = ppap.elements.find((e) => e.key === "part_submission_warrant");
  if (!psw && element?.requirement === "not_required") return null;
  const pending = (a) => mutation.isPending && mutation.variables?.action === a;

  return (
    <MenuCard
      title="Part Submission Warrant"
      subtitle="Typed by the person preparing the submission, signed by an approver who did not prepare it"
      action={
        <Link to={pswPath(ppap.id)} className="text-sm text-link-color hover:underline">
          View the form
        </Link>
      }
    >
      {ppap.canSavePsw ? (
        <PswFields key={`${ppap.updatedAt}-${psw ? "saved" : "new"}`} ppap={ppap} mutation={mutation} />
      ) : (
        <dl className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Part weight">{psw?.partWeight == null ? "—" : `${psw.partWeight} ${psw.weightUnit}`}</Fact>
          <Fact label="Purchase order">{psw?.purchaseOrder ?? "—"}</Fact>
          <Fact label="Engineering change level">{psw?.engineeringChangeLevel ?? "—"}</Fact>
          <Fact label="Results meet the requirements">{psw?.resultsMeetRequirements == null ? "—" : psw.resultsMeetRequirements ? "Yes" : "No"}</Fact>
          {psw?.declaration && <Fact label="Declaration">{psw.declaration}</Fact>}
        </dl>
      )}
      <div className="flex flex-col gap-2 border-t border-border-color p-4">
        {psw?.signature ? (
          <Callout
            tone="success"
            title="Signed"
            action={
              ppap.canUnsign ? (
                <CTAButton type="neutral" size="md" onClick={() => setDialog("unsign")}>
                  Take the signature off
                </CTAButton>
              ) : undefined
            }
          >
            {psw.signature.name}
            {psw.signature.title ? `, ${psw.signature.title}` : ""}
            {psw.signature.phone ? ` · ${psw.signature.phone}` : ""} — {formatDay(psw.signature.on)}
            {psw.frozen && <span className="text-secondary-text"> · frozen when the submission was sent</span>}
          </Callout>
        ) : (
          <>
            {psw?.unsigned && (
              <p className="text-sm text-secondary-text">
                The signature was taken off on {formatDay(psw.unsigned.at.slice(0, 10))}: {psw.unsigned.reason}
              </p>
            )}
            {ppap.signBlocked && <Callout tone="warning">{ppap.signBlocked}</Callout>}
            {psw && psw.missing.length > 0 && <p className="text-sm text-secondary-text">Still to fill in before it can be signed: {psw.missing.join(", ")}.</p>}
            {!psw && <p className="text-sm text-secondary-text">Nothing has been typed yet.</p>}
            {ppap.canSign && (
              <div className="flex justify-end">
                <CTAButton type="main" size="md" loading={pending("signPsw")} onClick={() => setDialog("sign")}>
                  Sign the warrant
                </CTAButton>
              </div>
            )}
          </>
        )}
      </div>
      {dialog === "sign" && <SignDialog ppap={ppap} onClose={() => setDialog(null)} />}
      {dialog === "unsign" && (
        <ReasonForm
          title="Take the signature off"
          label="Why is the signature taken off"
          submitLabel="Take it off"
          tone="danger"
          pending={pending("unsignPsw")}
          error={mutation.error}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => mutation.mutate({ action: "unsignPsw", id: ppap.id, body: { reason } }, { onSuccess: () => setDialog(null) })}
        />
      )}
    </MenuCard>
  );
};

// ---- sending ---------------------------------------------------------------------------------------------

/** Send the submission: when and how it was sent. Everything linked and the warrant are frozen at this moment. */
export const SubmitDialog = ({ ppap, onClose }) => {
  const mutation = usePpapMutation();
  const { showToast } = useToast();
  const [sentOn, setSentOn] = useState(todayIso());
  const [how, setHow] = useState("");
  const [note, setNote] = useState("");
  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      { action: "submit", id: ppap.id, body: { ...(sentOn ? { sentOn } : {}), ...(how.trim() ? { how: how.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not sent", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={ppap.direction === "received" ? `Record ${ppap.reference} as received from ${ppap.supplier?.name ?? "the supplier"}` : `Send ${ppap.reference} to ${ppap.customer?.name ?? "the customer"}`} onClose={onClose} width="max-w-lg">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <Callout tone="info">
          Sending freezes the warrant and records what every linked record is now. A later change to one of them shows as "changed since it was submitted". It cannot be edited after this; if the customer rejects it, you start a new submission.
        </Callout>
        <RHFDatePickerPopout label={ppap.direction === "received" ? "Received on" : "Sent on"} valueFormat="iso" allowFuture={false} value={sentOn} onChange={(d) => setSentOn(d ?? "")} />
        <TextInput label="How it was sent" value={how} onChange={(e) => setHow(e.target.value)} maxLength={200} hint="Their portal, email, courier …" />
        <TextAreaField label="Note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} label={ppap.direction === "received" ? "Record it" : "Send it"} />
      </form>
    </Dialog>
  );
};

// ---- the customer's decision -----------------------------------------------------------------------------

/** Record what the customer decided: approved, interim approved (with the day it runs to and the conditions) or rejected (with the reason), their reference and their signed warrant. */
export const DecisionDialog = ({ ppap, onClose }) => {
  const mutation = usePpapMutation();
  const { organisationId } = useOrganisation();
  const { showToast } = useToast();
  const [kind, setKind] = useState("approved");
  const [decidedOn, setDecidedOn] = useState(todayIso());
  const [reference, setReference] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const needsNote = kind === "interim_approved" || kind === "rejected";
  const tooBig = file && file.size > 26214400;
  const valid = decidedOn && (!needsNote || note.trim()) && (kind !== "interim_approved" || expiresOn) && !tooBig;

  const send = (path) =>
    mutation.mutate(
      {
        action: "decide",
        id: ppap.id,
        body: {
          kind,
          decidedOn,
          ...(reference.trim() ? { theirReference: reference.trim() } : {}),
          ...(kind === "interim_approved" ? { expiresOn } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(path ? { storagePath: path, fileName: file.name, contentType: file.type || null, sizeBytes: file.size } : {}),
        },
      },
      {
        onSuccess: onClose,
        onError: (err) => showToast({ type: "error", title: "Not recorded", message: describeApiError(err) }),
        onSettled: () => setUploading(false),
      },
    );

  const submit = async (e) => {
    e.preventDefault();
    if (!valid) return;
    if (!file) return send(null);
    setUploading(true);
    try {
      const { path } = await uploadFileToSupabase(file, "ppap-files", organisationId, ppap.id, "ppap");
      send(path);
    } catch (err) {
      setUploading(false);
      showToast({ type: "error", title: "The file was not uploaded", message: describeApiError(err) });
    }
  };

  return (
    <Dialog title={ppap.direction === "received" ? "Record our decision" : "Record the customer's decision"} onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <ComboField label={ppap.direction === "received" ? "What did we decide" : "What did they decide"} required value={kind} onChange={(v) => setKind(v ?? "approved")} options={DECISION_CHOICES} clearable={false} sort={false} />
        <RHFDatePickerPopout label="Decided on" required valueFormat="iso" allowFuture={false} value={decidedOn} onChange={(d) => setDecidedOn(d ?? "")} />
        {kind === "interim_approved" && <RHFDatePickerPopout label="Runs to" required valueFormat="iso" minDate={decidedOn || undefined} value={expiresOn} onChange={(d) => setExpiresOn(d ?? "")} />}
        <TextInput label={ppap.direction === "received" ? "Our reference" : "Their reference"} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        <TextAreaField
          label={kind === "interim_approved" ? "The conditions" : kind === "rejected" ? "Why it was rejected" : "Note"}
          required={needsNote}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={2000}
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Their signed warrant (optional)</span>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="min-h-9.5 rounded-md border border-border-color bg-secondary-bg p-1.5 text-sm" />
          <span className="text-xs text-secondary-text">{file ? `${file.name} · ${fileSizeLabel(file.size)}` : "Up to 25 MB"}</span>
        </label>
        {tooBig && <p role="alert" className="text-sm text-error-color">That file is over 25 MB.</p>}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={uploading || mutation.isPending} disabled={!valid} label="Record it" />
      </form>
    </Dialog>
  );
};

// ---- resubmitting and reviewing --------------------------------------------------------------------------

/** Start a new submission that replaces this one. Links and notes come across; files, waivers and the signature do not. */
export const ResubmitDialog = ({ ppap, onClose }) => {
  const mutation = usePpapMutation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [reason, setReason] = useState(ppap.status === "approved" ? null : ppap.reason);
  const [level, setLevel] = useState("");
  const revalidating = ppap.status === "approved";
  const submit = (e) => {
    e.preventDefault();
    if (!reason) return;
    mutation.mutate(
      { action: "resubmit", id: ppap.id, body: { reason, ...(level ? { level: Number(level) } : {}) } },
      {
        onSuccess: (made) => {
          onClose();
          if (made?.id) navigate(ppapPath(made.id));
        },
        onError: (err) => showToast({ type: "error", title: "Not started", message: describeApiError(err) }),
      },
    );
  };
  return (
    <Dialog title={revalidating ? `Revalidate ${ppap.reference}` : `Resubmit ${ppap.reference}`} onClose={onClose} width="max-w-lg">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          This starts a new submission that names {ppap.reference}. The links and notes come across and follow the current records; files, waivers and the signature do not, so the warrant needs signing again.
        </p>
        <ComboField
          label="Why is it being submitted"
          required
          value={reason}
          onChange={setReason}
          options={REASONS}
          clearable={false}
          sort={false}
          hint={revalidating ? "Choose a reason different from the approved submission's" : undefined}
        />
        <ComboField
          label="Level"
          value={level}
          onChange={(v) => setLevel(v ?? "")}
          options={[{ value: "", label: `The same level (${levelLabel(ppap.level)})` }, ...[1, 2, 3, 4, 5].map((l) => ({ value: String(l), label: levelLabel(l) }))]}
          clearable={false}
          sort={false}
        />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!reason} label="Start the new submission" />
      </form>
    </Dialog>
  );
};

const ReviewDialog = ({ ppap, onClose }) => {
  const mutation = usePpapMutation();
  const { showToast } = useToast();
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (!note.trim()) return;
    mutation.mutate(
      { action: "review", id: ppap.id, body: { note: note.trim(), ...(next ? { nextReviewOn: next } : {}) } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not recorded", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={`Review ${ppap.reference}`} onClose={onClose} width="max-w-lg">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <TextAreaField label="What was checked, and that nothing changed" required value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} />
        <RHFDatePickerPopout label="Next review" valueFormat="iso" allowPast={false} clearable value={next} onChange={(d) => setNext(d ?? "")} placeholder="A year from today" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!note.trim()} label="Record the review" />
      </form>
    </Dialog>
  );
};

// ---- what happened ---------------------------------------------------------------------------------------

const openDecisionFile = async (file, showToast) => {
  const url = await generateSignedUrl("ppap-files", file.storagePath);
  if (url) window.open(url, "_blank", "noopener");
  else showToast({ type: "error", title: "The file could not be opened", message: "Try again in a moment." });
};

/** What happened and when: sent, each decision of the customer, a withdrawal; reviews; and the buttons that follow (record a decision, resubmit, review). */
export const DecisionsCard = ({ ppap }) => {
  const [dialog, setDialog] = useState(null);
  const { showToast } = useToast();
  const visible = ppap.decisions.length > 0 || ppap.reviews.length > 0 || ppap.canRecordDecision || ppap.replaces || ppap.replacedBy.length > 0;
  if (!visible) return null;

  return (
    <MenuCard
      title="What happened"
      subtitle="Recorded as it happened and never edited"
      action={
        <div className="flex flex-wrap gap-2">
          {ppap.canRecordDecision && (
            <CTAButton type="main" size="md" onClick={() => setDialog("decide")}>
              {ppap.direction === "received" ? "Record our decision" : "Record the customer's decision"}
            </CTAButton>
          )}
          {ppap.canReview && (
            <CTAButton type="neutral" size="md" onClick={() => setDialog("review")}>
              Record a review
            </CTAButton>
          )}
          {ppap.canResubmit && (
            <CTAButton type="secondary" size="md" onClick={() => setDialog("resubmit")}>
              {ppap.status === "approved" ? "Revalidate with a new submission" : "Resubmit"}
            </CTAButton>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        {(ppap.replaces || ppap.replacedBy.length > 0) && (
          <p className="text-sm text-secondary-text">
            {ppap.replaces && (
              <>
                Replaces{" "}
                <Link to={ppapPath(ppap.replaces.id)} className="text-link-color hover:underline">
                  {ppap.replaces.reference}
                </Link>
                .{" "}
              </>
            )}
            {ppap.replacedBy.length > 0 && (
              <>
                Replaced by{" "}
                {ppap.replacedBy.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 && ", "}
                    <Link to={ppapPath(r.id)} className="text-link-color hover:underline">
                      {r.reference}
                    </Link>
                  </span>
                ))}
                .
              </>
            )}
          </p>
        )}
        {ppap.decisions.length === 0 ? (
          <p className="text-sm text-secondary-text">Nothing has been sent yet.</p>
        ) : (
          <ol aria-label="Decisions" className="flex flex-col gap-2">
            {ppap.decisions.map((d) => (
              <li key={d.id} className="flex flex-col gap-0.5 rounded-md border border-border-color p-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${decisionPill(d.kind)}`}>{decisionLabel(d.kind, ppap.direction)}</span>
                  <span className="font-medium text-primary-text">{formatDay(d.decidedOn)}</span>
                  {d.how && <span className="text-secondary-text">via {d.how}</span>}
                  {d.theirReference && <span className="text-secondary-text">their reference {d.theirReference}</span>}
                  {d.expiresOn && <span className="text-secondary-text">runs to {formatDay(d.expiresOn)}</span>}
                  <span className="ml-auto text-secondary-text">{d.recordedBy?.name}</span>
                </div>
                {d.note && <p className="whitespace-pre-wrap text-primary-text">{d.note}</p>}
                {d.file && (
                  <button type="button" onClick={() => openDecisionFile(d.file, showToast)} className="w-fit text-link-color hover:underline cursor-pointer">
                    {d.file.fileName} · {fileSizeLabel(d.file.sizeBytes)}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        {ppap.reviews.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-primary-text">Reviews</h3>
            <ul aria-label="Reviews" className="mt-1 flex flex-col gap-1 text-sm">
              {ppap.reviews.map((r) => (
                <li key={r.id} className="text-primary-text">
                  {r.outcome === "no_change" ? (
                    <>
                      {formatDay(r.at.slice(0, 10))}: nothing changed. {r.note} <span className="text-secondary-text">Next review {formatDay(r.nextReviewOn)}. {r.by?.name}</span>
                    </>
                  ) : (
                    <>
                      {formatDay(r.at.slice(0, 10))}: a new submission was started
                      {r.newSubmission && (
                        <>
                          {" "}
                          (
                          <Link to={ppapPath(r.newSubmission.id)} className="text-link-color hover:underline">
                            {r.newSubmission.reference}
                          </Link>
                          )
                        </>
                      )}
                      . <span className="text-secondary-text">{r.by?.name}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {dialog === "decide" && <DecisionDialog ppap={ppap} onClose={() => setDialog(null)} />}
      {dialog === "review" && <ReviewDialog ppap={ppap} onClose={() => setDialog(null)} />}
      {dialog === "resubmit" && <ResubmitDialog ppap={ppap} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
};
