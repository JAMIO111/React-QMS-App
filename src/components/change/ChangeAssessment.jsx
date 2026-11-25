import { useState } from "react";
import CTAButton from "@/components/CTAButton";
import { CheckIcon, PencilIcon, PlusIcon, XIcon } from "@/components/icons";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useAuth } from "../../contexts/AuthProvider";
import { useChangeFunctions, useChangeMutation, useChangeSigners, useCustomerApprovalRequests } from "../../hooks/useChange";
import { ApprovalRequests, AskCustomerDialog } from "./ChangeCustomerApproval";
import { CUSTOMER_APPROVALS, CUT_IN_KINDS, customerLabel, cutInWords, formatDay, IMPACT_OPTIONS, impactLabel, impactPill, signoffLabel, signoffPill, STOCK_ACTIONS, stockLabel } from "../../lib/change";
import { FormError, TextAreaField } from "../master-data/shared";
import { OrderPicker, LotPicker, SerialPicker } from "../production/pickers";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";

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

/** Say how an area is affected (a note is needed for "affected"). */
const ImpactNoteDialog = ({ change, impact, onClose }) => {
  const mutation = useChangeMutation();
  const [note, setNote] = useState(impact.note ?? "");
  const save = (e) => {
    e.preventDefault();
    if (note.trim().length < 3) return;
    mutation.mutate({ action: "setImpact", id: change.id, body: { areaId: impact.areaId, status: "affected", note: note.trim() } });
    onClose();
  };
  return (
    <Dialog title={`${impact.label}: how is it affected?`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <TextAreaField label="How it is affected" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={4} required hint={impact.description ?? undefined} />
        <Buttons onClose={onClose} disabled={note.trim().length < 3} label="Save" />
      </form>
    </Dialog>
  );
};

/** The impact assessment: every area marked affected (with how), not affected, or not assessed. Editable while the change is in assessment. */
export const ImpactCard = ({ change }) => {
  const mutation = useChangeMutation();
  const [asking, setAsking] = useState(null);
  if (change.impacts.length === 0) return null;
  const left = change.impacts.filter((i) => i.status === "not_assessed").length;
  const choose = (impact, status) => {
    if (status === impact.status) return;
    if (status === "affected") return setAsking(impact);
    // Shown at once; a refusal puts it back and is told in a toast (useChangeMutation).
    mutation.mutate({ action: "setImpact", id: change.id, body: { areaId: impact.areaId, status, note: null } });
  };
  return (
    <MenuCard
      title="Impact assessment"
      subtitle={change.canAssess ? `What else this change touches. ${left ? `${left} of ${change.impacts.length} still to assess.` : "Every area is assessed."}` : "What else this change touches."}>
      <ul aria-label="Impact assessment" className="-my-3 divide-y divide-border-color">
        {change.impacts.map((i) => (
          <li key={i.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col">
              <span className="font-medium text-primary-text">{i.label}</span>
              {i.note ? (
                <span className="whitespace-pre-wrap text-sm text-secondary-text">{i.note}</span>
              ) : (
                i.description && <span className="text-sm text-secondary-text">{i.description}</span>
              )}
            </div>
            {change.canAssess ? (
              <SlidingToggle ariaLabel={`${i.label} impact`} options={IMPACT_OPTIONS} value={i.status} onChange={(v) => choose(i, v)} />
            ) : (
              <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${impactPill(i.status)}`}>{impactLabel(i.status)}</span>
            )}
          </li>
        ))}
      </ul>
      {asking && <ImpactNoteDialog change={change} impact={asking} onClose={() => setAsking(null)} />}
    </MenuCard>
  );
};

/** Choose who signs for which function. */
const BoardDialog = ({ change, onClose }) => {
  const mutation = useChangeMutation();
  const functions = useChangeFunctions();
  const signers = useChangeSigners();
  const [chosen, setChosen] = useState(() => Object.fromEntries(change.board.map((b) => [b.function.id, b.signer?.id ?? null])));
  const people = (signers.data ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.canApprove ? undefined : "Cannot sign off changes", disabled: !p.canApprove }));
  const on = (id) => Object.prototype.hasOwnProperty.call(chosen, id);
  const toggle = (id) =>
    setChosen((c) => {
      const next = { ...c };
      if (on(id)) delete next[id];
      else next[id] = null;
      return next;
    });
  const entries = Object.entries(chosen);
  const ready = entries.length > 0 && entries.every(([, signer]) => signer);
  const save = () => {
    mutation.mutate({ action: "setBoard", id: change.id, body: { board: entries.map(([functionId, signerId]) => ({ functionId, signerId })) } }, { onSuccess: onClose });
  };
  return (
    <Dialog title="Who signs this change off" onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">Tick each function that has to agree, then choose who signs for it. They each sign separately. The person who raised the change cannot sign unless your organisation allows it.</p>
        <ul aria-label="Functions" className="flex flex-col gap-2">
          {(functions.data?.data ?? []).map((f) => (
            <li key={f.id} className="grid gap-2 rounded-lg border border-border-color bg-primary-bg p-3 sm:grid-cols-[14rem_1fr] sm:items-end">
              <label className="flex items-center gap-2 text-sm font-medium text-primary-text">
                <input type="checkbox" checked={on(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4" />
                {f.label}
              </label>
              {on(f.id) ? (
                <ComboField label={`Who signs for ${f.label}`} value={chosen[f.id]} onChange={(v) => setChosen((c) => ({ ...c, [f.id]: v }))} options={people} required />
              ) : (
                <span className="text-sm text-secondary-text">{f.description ?? "Not needed"}</span>
              )}
            </li>
          ))}
        </ul>
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="main" size="md" disabled={!ready || mutation.isPending} loading={mutation.isPending} onClick={save}>
            Save the board
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** A signer's decision: approve (a comment is optional) or send it back (a comment is needed). */
const DecideDialog = ({ signoff, approve, onClose }) => {
  const mutation = useChangeMutation();
  const { showToast } = useToast();
  const [comment, setComment] = useState("");
  const send = (e) => {
    e.preventDefault();
    if (!approve && comment.trim().length < 3) return;
    mutation.mutate(
      { action: "decide", id: signoff.id, body: { approve, comment: comment.trim() || null } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) },
    );
  };
  return (
    <Dialog title={approve ? `Approve for ${signoff.function.label}` : `Send back for ${signoff.function.label}`} onClose={onClose}>
      <form noValidate onSubmit={send} className="flex flex-col gap-3">
        <TextAreaField
          label={approve ? "Comment" : "Why are you sending it back?"}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={1000}
          rows={4}
          required={!approve}
          hint={approve ? "Optional" : "It returns to assessment with your reason, and everyone signs again after it is sent to the board."}
        />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!approve && comment.trim().length < 3} label={approve ? "Approve" : "Send it back"} type={approve ? "main" : "danger"} />
      </form>
    </Dialog>
  );
};

/** The board: who must sign for which function, and each sign-off with its decision, round by round. */
export const BoardCard = ({ change }) => {
  const [dialog, setDialog] = useState(null);
  const { user } = useAuth();
  if (change.stage === "draft" || (change.board.length === 0 && change.signoffs.length === 0 && !change.canAssess)) return null;
  const rounds = [...new Set(change.signoffs.map((s) => s.round))];
  return (
    <MenuCard
      title="Board and sign-off"
      subtitle="The functions that have to agree, and who signs for each."
      action={
        change.canAssess && (
          <CTAButton type="secondary" icon={change.board.length ? PencilIcon : PlusIcon} onClick={() => setDialog({ board: true })}>
            {change.board.length ? "Change the board" : "Choose the board"}
          </CTAButton>
        )
      }>
      <div className="flex flex-col gap-4">
        {change.stage === "assessment" &&
          (change.board.length === 0 ? (
            <p className="text-sm text-secondary-text">No board chosen yet.</p>
          ) : (
            <ul aria-label="Board" className="flex flex-col gap-1 text-sm">
              {change.board.map((b) => (
                <li key={b.id}>
                  <span className="font-medium text-primary-text">{b.function.label}</span> <span className="text-secondary-text">· {b.signer?.name ?? "Unknown"}{b.signer?.id === user?.id ? " (you)" : ""}</span>
                </li>
              ))}
            </ul>
          ))}
        {rounds.map((round) => (
          <section key={round} aria-label={`Round ${round}`} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-primary-text">{rounds.length > 1 ? `Round ${round}` : "Sign-offs"}</h3>
            <ul className="flex flex-col gap-2">
              {change.signoffs
                .filter((s) => s.round === round)
                .map((s) => (
                  <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border-color bg-primary-bg px-3 py-2 text-sm">
                    <div className="flex min-w-0 flex-col">
                      <span>
                        <span className="font-medium text-primary-text">{s.function.label}</span> <span className="text-secondary-text">· {s.signer?.name ?? "Unknown"}</span>
                      </span>
                      {s.comment && <span className="whitespace-pre-wrap text-secondary-text">“{s.comment}”</span>}
                      {s.decidedAt && <span className="text-xs text-secondary-text">{formatDay(s.decidedAt)}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${signoffPill(s.status)}`}>{signoffLabel(s.status)}</span>
                      {s.canDecide && (
                        <>
                          <CTAButton type="main" icon={CheckIcon} onClick={() => setDialog({ signoff: s, approve: true })}>
                            Approve
                          </CTAButton>
                          <CTAButton type="danger" icon={XIcon} onClick={() => setDialog({ signoff: s, approve: false })}>
                            Send back
                          </CTAButton>
                        </>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
      {dialog?.board && <BoardDialog change={change} onClose={() => setDialog(null)} />}
      {dialog?.signoff && <DecideDialog signoff={dialog.signoff} approve={dialog.approve} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
};

/** Where the change starts to apply, and what happens to stock already made. Recorded and shown; nothing is enforced on the shop floor. */
const CutInDialog = ({ change, onClose }) => {
  const mutation = useChangeMutation();
  const c = change.cutIn;
  const [kind, setKind] = useState(c.kind);
  const [date, setDate] = useState(c.date ?? "");
  const [order, setOrder] = useState(c.order?.id ?? null);
  const [lot, setLot] = useState(c.lot?.id ?? null);
  const [serial, setSerial] = useState(c.serial?.id ?? null);
  const [action, setAction] = useState(c.stockAction ?? null);
  const [note, setNote] = useState(c.stockNote ?? "");
  const ready = kind === "none" || (kind === "date" && date) || (kind === "order" && order) || (kind === "lot" && lot) || (kind === "serial" && serial);
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { kind, stockAction: action, stockNote: note.trim() || null };
    if (kind === "date") body.date = date;
    if (kind === "order") body.orderId = order;
    if (kind === "lot") body.lotId = lot;
    if (kind === "serial") body.serialId = serial;
    mutation.mutate({ action: "setCutIn", id: change.id, body }, { onSuccess: onClose });
  };
  return (
    <Dialog title="From when does it apply?" onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <ComboField label="Cut-in point" required value={kind} onChange={(v) => setKind(v ?? "none")} options={CUT_IN_KINDS} clearable={false} sort={false} />
        {kind === "date" && <RHFDatePickerPopout label="Date" required value={date} onChange={(v) => setDate(v ?? "")} valueFormat="iso" />}
        {kind === "order" && <OrderPicker label="Production order" required value={order} current={c.order ? { id: c.order.id, orderNumber: c.order.label } : undefined} onChange={(id) => setOrder(id)} />}
        {kind === "lot" && <LotPicker label="Lot" required value={lot} current={c.lot ? { id: c.lot.id, lotNumber: c.lot.label } : undefined} onChange={(id) => setLot(id)} />}
        {kind === "serial" && <SerialPicker label="Serial number" required value={serial} current={c.serial ? { id: c.serial.id, serialNumber: c.serial.label } : undefined} onChange={(id) => setSerial(id)} />}
        <ComboField label="Stock already made" value={action} onChange={setAction} options={STOCK_ACTIONS} clearable placeholder="Nothing said" sort={false} />
        <TextAreaField label="About existing stock" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} hint="Optional" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label="Save" />
      </form>
    </Dialog>
  );
};

export const CutInCard = ({ change }) => {
  const [open, setOpen] = useState(false);
  if (change.stage === "draft") return null;
  const words = cutInWords(change.cutIn);
  return (
    <MenuCard
      title="Cut-in point"
      subtitle="From when the change applies. It is recorded and shown, not enforced."
      action={
        change.canSetCutIn && (
          <CTAButton type="secondary" icon={PencilIcon} onClick={() => setOpen(true)}>
            {words ? "Change" : "Set"}
          </CTAButton>
        )
      }>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Applies</dt>
          <dd className="text-sm text-primary-text">{words ?? "No fixed point"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Stock already made</dt>
          <dd className="whitespace-pre-wrap text-sm text-primary-text">{[stockLabel(change.cutIn.stockAction), change.cutIn.stockNote].filter(Boolean).join(" — ") || "Nothing said"}</dd>
        </div>
      </dl>
      {open && <CutInDialog change={change} onClose={() => setOpen(false)} />}
    </MenuCard>
  );
};

/** Record what the customer said (the approval itself is not run here). */
const CustomerDialog = ({ change, onClose }) => {
  const mutation = useChangeMutation();
  const c = change.customerApproval;
  const [status, setStatus] = useState(c.status ?? null);
  const [reference, setReference] = useState(c.reference ?? "");
  const [on, setOn] = useState(c.on ?? "");
  const [why, setWhy] = useState(c.waivedReason ?? "");
  const ready = status && (status !== "waived" || why.trim().length >= 10);
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { status, reference: reference.trim() || null, on: on || null, waivedReason: status === "waived" ? why.trim() : null };
    mutation.mutate({ action: "setCustomerApproval", id: change.id, body }, { onSuccess: onClose });
  };
  return (
    <Dialog title="The customer's approval" onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <ComboField label="Where it stands" required value={status} onChange={setStatus} options={CUSTOMER_APPROVALS} sort={false} />
        {["requested", "approved", "rejected"].includes(status) && (
          <>
            <Field label="Their reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} hint="Their approval or PCN number, if they gave one" />
            <RHFDatePickerPopout label="Date" value={on} onChange={(v) => setOn(v ?? "")} valueFormat="iso" allowFuture={false} clearable />
          </>
        )}
        {status === "waived" && <TextAreaField label="Why is it waived?" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} rows={3} required hint="At least 10 characters" />}
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label="Save" />
      </form>
    </Dialog>
  );
};

export const CustomerCard = ({ change }) => {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const c = change.customerApproval;
  const needed = change.typeNeedsCustomerApproval;
  const approvals = useCustomerApprovalRequests(change.id, { enabled: change.stage !== "draft" });
  const customers = approvals.data?.customers ?? [];
  const requests = approvals.data?.data ?? [];
  const waiting = requests.some((r) => r.status === "pending");
  const canAsk = change.canSetCustomerApproval && change.stage !== "draft" && customers.length > 0 && !waiting && c.status !== "approved";
  if (change.stage === "draft" && !c.status && !needed) return null;
  return (
    <MenuCard
      title="Customer approval"
      subtitle="Record the customer's answer here, or ask a customer to approve it in their portal."
      action={
        change.canSetCustomerApproval && (
          <div className="flex flex-wrap gap-2">
            {canAsk && (
              <CTAButton type="main" onClick={() => setAsking(true)}>
                Ask the customer
              </CTAButton>
            )}
            <CTAButton type="secondary" icon={PencilIcon} onClick={() => setOpen(true)}>
              {c.status ? "Change" : "Record"}
            </CTAButton>
          </div>
        )
      }>
      {!c.status && needed && change.stage !== "cancelled" && (
        <div className="mb-3">
          <Callout tone="info">This type of change usually needs the customer. Say whether it does before it goes to the board.</Callout>
        </div>
      )}
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Where it stands</dt>
          <dd className="text-sm text-primary-text">{customerLabel(c.status)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Their reference</dt>
          <dd className="text-sm text-primary-text">{c.reference ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Date</dt>
          <dd className="text-sm text-primary-text">{c.on ? formatDay(c.on) : "—"}</dd>
        </div>
        {c.waivedReason && (
          <div className="sm:col-span-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-secondary-text">Why it is waived</dt>
            <dd className="whitespace-pre-wrap text-sm text-primary-text">{c.waivedReason}</dd>
          </div>
        )}
      </dl>
      <ApprovalRequests requests={requests} canWithdraw={change.canSetCustomerApproval} />
      {open && <CustomerDialog change={change} onClose={() => setOpen(false)} />}
      {asking && <AskCustomerDialog change={change} customers={customers} onClose={() => setAsking(false)} />}
    </MenuCard>
  );
};
