import { useEffect, useState } from "react";
import CTAButton from "@/components/CTAButton";
import { QrCodeIcon, UsersIcon } from "@/components/icons";
import { uploadFileToSupabase } from "../../api/supabaseApi";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { useToast } from "../../contexts/ToastProvider";
import { usePpapCandidates, usePpapMutation } from "../../hooks/usePpap";
import { describeApiError } from "../../lib/api-client";
import { withVersion } from "../../lib/editConflicts";
import { LEVELS, REASONS, fileSizeLabel, levelLabel, linkKindLabel, linkKindsFor, verdictPill } from "../../lib/ppap";
import { FormError, TextAreaField } from "../master-data/shared";
import { PartPicker, PartyPicker, RevisionPicker } from "../ncr/Pickers";
import ComboField from "../ui/ComboField";
import SlidingToggle from "../ui/SlidingToggle";
import Dialog from "../ui/Dialog";

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

const LEVEL_CHOICES = [{ value: "", label: "The customer's usual level, else the organisation's" }, ...LEVELS.map((l) => ({ value: String(l), label: levelLabel(l) }))];

/** Start a submission: the part and revision, the customer, why, and (optionally) a level. The 18 elements are set from the level and the customer's rules. */
export const NewPpapDialog = ({ onClose, onSaved, defaults }) => {
  const mutation = usePpapMutation();
  const { showToast } = useToast();
  const [part, setPart] = useState(defaults?.part ?? null);
  const [revisionId, setRevisionId] = useState(defaults?.partRevisionId ?? null);
  const [direction, setDirection] = useState(defaults?.direction ?? "submitted");
  const [customer, setCustomer] = useState(defaults?.customer ?? null);
  const [supplier, setSupplier] = useState(defaults?.supplier ?? null);
  const [level, setLevel] = useState("");
  const [reason, setReason] = useState(defaults?.reason ?? null);
  const [notes, setNotes] = useState(defaults?.notes ?? "");
  // one key for this dialog, so a retried request after a dropped connection returns the same submission
  const [clientKey] = useState(() => crypto.randomUUID());
  const received = direction === "received";
  const ready = part?.id && (received ? supplier?.id : customer?.id) && reason;

  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    mutation.mutate(
      {
        action: "create",
        body: {
          partId: part.id,
          ...(received ? { direction: "received", supplierId: supplier.id } : { customerId: customer.id }),
          reason,
          clientKey,
          ...(revisionId ? { partRevisionId: revisionId } : {}),
          ...(level ? { level: Number(level) } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(defaults?.raisedFrom ? { raisedFrom: defaults.raisedFrom } : {}),
        },
      },
      {
        onSuccess: (ppap) => {
          onSaved?.(ppap);
          onClose();
        },
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      }
    );
  };

  return (
    <Dialog title={received ? "Record a package from a supplier" : "Start a PPAP submission"} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        {defaults?.raisedFrom && defaults?.source && <p className="text-sm text-secondary-text">Raised from {defaults.source.reference}: {defaults.source.title}. It is kept with the PPAP.</p>}
        <SlidingToggle ariaLabel="Which way" mode="radio" value={direction} onChange={setDirection} options={[{ value: "submitted", label: "We send it to a customer" }, { value: "received", label: "A supplier sent it to us" }]} />
        <PartPicker label="Part" icon={QrCodeIcon} required value={part?.id ?? null} current={part?.id ? { id: part.id, partNumber: part.name ?? "" } : undefined} onChange={(id, item) => { setPart(id ? { id, name: item?.name ?? "" } : null); setRevisionId(null); }} />
        <RevisionPicker label="Part revision" partId={part?.id} value={revisionId} onChange={(id) => setRevisionId(id ?? null)} hint="Leave empty to use the released revision" />
        {received ? (
          <PartyPicker label="Supplier" kind="suppliers" icon={UsersIcon} required value={supplier?.id ?? null} current={supplier?.id ? { id: supplier.id, name: supplier.name ?? "" } : undefined} onChange={(id, item) => setSupplier(id ? { id, name: item?.name ?? "" } : null)} />
        ) : (
          <PartyPicker label="Customer" kind="customers" icon={UsersIcon} required value={customer?.id ?? null} current={customer?.id ? { id: customer.id, name: customer.name ?? "" } : undefined} onChange={(id, item) => setCustomer(id ? { id, name: item?.name ?? "" } : null)} />
        )}
        <ComboField label={received ? "Why they sent it" : "Why is it being submitted"} required value={reason} onChange={setReason} options={REASONS} clearable={false} sort={false} />
        <ComboField label="Level" value={level} onChange={(v) => setLevel(v ?? "")} options={LEVEL_CHOICES} clearable={false} sort={false} hint="Decides which of the 18 elements are required. You can change it while you prepare." />
        <TextAreaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} label={received ? "Record the package" : "Start the submission"} />
      </form>
    </Dialog>
  );
};

/** Change why a submission is being made and its notes, while it is being prepared. */
export const EditPpapDialog = ({ ppap, onClose }) => {
  const mutation = usePpapMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState(ppap.reason);
  const [notes, setNotes] = useState(ppap.notes ?? "");
  const save = (e) => {
    e.preventDefault();
    mutation.mutate(
      { action: "update", id: ppap.id, body: withVersion(ppap, { reason, notes: notes.trim() || null }) },
      {
        onSuccess: onClose,
        onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
      }
    );
  };
  return (
    <Dialog title={`Edit ${ppap.reference}`} onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <ComboField label="Why is it being submitted" required value={reason} onChange={(v) => setReason(v ?? ppap.reason)} options={REASONS} clearable={false} sort={false} />
        <TextAreaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} label="Save" />
      </form>
    </Dialog>
  );
};

/** One reason, written down: used to withdraw a submission, remove evidence and waive an element. `minLength` is what the database asks for. */
export const ReasonDialog = ({ title, label = "Reason", hint, minLength = 3, submitLabel, tone = "main", onSubmit, pending, error, onClose }) => {
  const [reason, setReason] = useState("");
  const valid = reason.trim().length >= minLength;
  const submit = (e) => {
    e.preventDefault();
    if (valid) onSubmit(reason.trim());
  };
  return (
    <Dialog title={title} onClose={onClose} width="max-w-lg">
      <form noValidate onSubmit={submit} className="flex flex-col gap-3">
        <TextAreaField label={label} required value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} hint={hint ?? `At least ${minLength} characters`} />
        <FormError error={error} />
        <Buttons onClose={onClose} pending={pending} disabled={!valid} label={submitLabel} type={tone} />
      </form>
    </Dialog>
  );
};

/** Add a file as evidence for an element: it is uploaded to the submission's own folder, then recorded. */
export const AddFileDialog = ({ ppap, element, onClose }) => {
  const mutation = usePpapMutation();
  const { organisationId } = useOrganisation();
  const { showToast } = useToast();
  const [file, setFile] = useState(null);
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const tooBig = file && file.size > 26214400;

  const save = async (e) => {
    e.preventDefault();
    if (!file || tooBig) return;
    setUploading(true);
    try {
      const { path } = await uploadFileToSupabase(file, "ppap-files", organisationId, ppap.id, "ppap");
      mutation.mutate(
        { action: "addFile", id: element.id, body: { storagePath: path, fileName: file.name, contentType: file.type || null, sizeBytes: file.size, description: description.trim() || null } },
        {
          onSuccess: onClose,
          onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
          onSettled: () => setUploading(false),
        }
      );
    } catch (err) {
      setUploading(false);
      showToast({ type: "error", title: "The file was not uploaded", message: describeApiError(err) });
    }
  };

  return (
    <Dialog title={`Add evidence: ${element.label}`} onClose={onClose} width="max-w-lg">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span data-required="true" className="font-medium">File</span>
          <input type="file" aria-required="true" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="min-h-9.5 rounded-md border border-border-color bg-secondary-bg p-1.5 text-sm" />
          <span className="text-xs text-secondary-text">{file ? `${file.name} · ${fileSizeLabel(file.size)}` : "Up to 25 MB"}</span>
        </label>
        {tooBig && <p role="alert" className="text-sm text-error-color">That file is over 25 MB.</p>}
        <TextAreaField label="What it is" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={uploading || mutation.isPending} disabled={!file || tooBig} label="Add the file" />
      </form>
    </Dialog>
  );
};

/**
 * Link a record Fortress already holds as evidence for an element. The choices are the records that fit (the kind, the submission's part), read as the person, each with its own
 * state beside its name so a record that is not in good standing is seen before it is chosen; a search widens it to the whole organisation.
 */
export const LinkDialog = ({ element, onClose }) => {
  const mutation = usePpapMutation();
  const { showToast } = useToast();
  const kinds = linkKindsFor(element.key);
  const [kind, setKind] = useState(kinds[0]);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const candidates = usePpapCandidates({ elementId: element.id, kind, q });
  const rows = candidates.data?.data ?? [];

  const link = (row) =>
    mutation.mutate(
      { action: "addLink", id: element.id, body: { kind, targetId: row.id, ...(description.trim() ? { description: description.trim() } : {}) } },
      { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not linked", message: describeApiError(err) }) },
    );

  return (
    <Dialog title={`Link a record: ${element.label}`} onClose={onClose} width="max-w-2xl">
      <div className="flex flex-col gap-3">
        {kinds.length > 1 && (
          <ComboField
            label="What to link"
            value={kind}
            onChange={(v) => v && setKind(v)}
            options={kinds.map((k) => ({ value: k, label: linkKindLabel(k)[0].toUpperCase() + linkKindLabel(k).slice(1) }))}
            clearable={false}
            sort={false}
          />
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Search</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Find a ${linkKindLabel(kind)} by its number or name`} className="min-h-9.5 rounded-md border border-border-color bg-secondary-bg px-3 text-sm" />
          <span className="text-xs text-secondary-text">{q.trim() ? "Searching every record you can read." : "Showing the ones that fit this part. Search to look further."}</span>
        </label>
        <TextAreaField label="What it is (optional)" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
        <ul aria-label={`${linkKindLabel(kind)} choices`} className="flex max-h-80 flex-col overflow-y-auto rounded-md border border-border-color">
          {candidates.isLoading && <li className="p-3 text-sm text-secondary-text">Looking…</li>}
          {!candidates.isLoading && rows.length === 0 && <li className="p-3 text-sm text-secondary-text">Nothing fits. Try a search.</li>}
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 border-b border-border-color p-2 last:border-0">
              <div className="min-w-48 flex-1">
                <p className="text-sm font-medium text-primary-text">{row.label}</p>
                <p className="text-xs text-secondary-text">{row.ok ? "In good standing" : `It ${row.problem ?? "is not in good standing"}`}</p>
              </div>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${verdictPill(row.ok ? "success" : "error")}`}>{String(row.status).replace(/_/g, " ")}</span>
              {row.linked ? (
                <span className="w-20 text-right text-sm text-secondary-text">Linked</span>
              ) : (
                <CTAButton type="secondary" size="md" aria-label={`Link ${row.label}`} loading={mutation.isPending && mutation.variables?.body?.targetId === row.id} onClick={() => link(row)}>
                  Link
                </CTAButton>
              )}
            </li>
          ))}
        </ul>
        <FormError error={candidates.error ?? mutation.error} />
        <div className="flex justify-end">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Close
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};
