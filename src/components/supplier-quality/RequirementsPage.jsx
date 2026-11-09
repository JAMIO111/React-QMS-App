import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { useIncomingMutation, useRequirements } from "../../hooks/useIncoming";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDate } from "../../lib/ncr";
import { REQUIREMENT_FILTERS, REQUIREMENT_STATUS, appliesTo, levelLabel, strategySummary } from "../../lib/incoming";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import RequirementDialog from "./RequirementDialog";

const StatusPill = ({ status }) => {
  const s = REQUIREMENT_STATUS[status] ?? REQUIREMENT_STATUS.draft;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

/** Approve (with a note) or retire (with a reason): one small dialog for both. */
const NoteDialog = ({ requirement, kind, onClose }) => {
  const mutation = useIncomingMutation();
  const [text, setText] = useState("");
  const approve = kind === "approve";
  const need = approve ? (requirement.reducesControls ? 10 : 0) : 3;
  return (
    <Dialog title={approve ? `Approve "${requirement.name}"` : `Retire "${requirement.name}"`} onClose={onClose} width="max-w-lg">
      <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= need && !mutation.isPending) mutation.mutate(approve ? { action: "approveRequirement", id: requirement.id, body: text.trim() ? { note: text.trim() } : {} } : { action: "retireRequirement", id: requirement.id, body: { reason: text.trim() } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">
          {approve ? "Once approved it applies to deliveries and can no longer be edited: a change is a new requirement that replaces it. You cannot approve what you wrote or last edited." : "A retired requirement no longer applies. It is kept, with the reason."}
        </p>
        {approve && requirement.reducesControls && <Callout tone="warning" title="This reduces inspection">Say why that is justified (at least 10 characters).</Callout>}
        <TextAreaField label={approve ? "Note" : "Why is it being retired?"} required={need > 0} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type={approve ? "main" : "danger"} size="lg" disabled={text.trim().length < need || mutation.isPending}>{mutation.isPending ? "Saving…" : approve ? "Approve" : "Retire"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** What to inspect when a delivery arrives, by supplier, part, family, classification and risk. A rule that reduces inspection is never applied to a part with a critical characteristic. */
const RequirementsPage = () => {
  const { can } = usePermissions();
  const [filter, setFilter] = useState("active");
  const [dialog, setDialog] = useState(null);
  const query = useRequirements({ status: filter });
  const approvedQuery = useRequirements({ status: "approved" });
  const rows = query.data ?? [];
  const manage = can("supplier_quality.manage");
  const approve = can("supplier_quality.approve");
  const close = () => setDialog(null);
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Incoming inspection requirements</h1>
          <p className="text-sm text-secondary-text">What to inspect when goods arrive. A requirement is written as a draft and approved by someone else. The most specific approved one that fits a delivery is used; a part with a critical characteristic is never inspected less than in full.</p>
        </div>
        {manage && <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setDialog({ kind: "edit" })}>Write a requirement</CTAButton>}
      </div>
      <SlidingToggle ariaLabel="Which requirements" options={REQUIREMENT_FILTERS} value={filter} onChange={setFilter} />
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : rows.length === 0 ? (
        <Callout tone="info" title="No requirements here">{filter === "active" ? "Without an approved requirement, deliveries are accepted without inspection. Write one to start." : "Nothing matches this view."}</Callout>
      ) : (
        <MenuCard title={`${rows.length} ${rows.length === 1 ? "requirement" : "requirements"}`} subtitle="Drafts first, then approved.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Inspection requirements">
              <thead>
                <tr className="text-left text-xs text-secondary-text">
                  <th className="py-1 pr-3 font-medium">Requirement</th>
                  <th className="py-1 pr-3 font-medium">Applies to</th>
                  <th className="py-1 pr-3 font-medium">Inspection</th>
                  <th className="py-1 pr-3 font-medium">Level</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border-color align-top">
                    <td className="py-2 pr-3 text-primary-text"><span className="font-medium">{r.name}</span>{r.rationale && <span className="block text-xs text-secondary-text">{r.rationale}</span>}<span className="block text-xs text-secondary-text">At {r.operationCode}{r.approvedAt ? ` · approved ${formatDate(r.approvedAt.slice(0, 10))}${r.approvedBy ? ` by ${r.approvedBy.name}` : ""}` : ""}</span></td>
                    <td className="py-2 pr-3 text-secondary-text">{appliesTo(r)}</td>
                    <td className="py-2 pr-3 text-primary-text">{strategySummary(r)}</td>
                    <td className="py-2 pr-3 text-primary-text">{levelLabel(r.level)}{r.reducesControls && <span className="ml-2 rounded-full bg-warning-color/20 px-2 py-0.5 text-xs font-medium text-primary-text">Reduces inspection</span>}</td>
                    <td className="py-2 pr-3"><StatusPill status={r.status} /></td>
                    <td className="py-2 text-right">
                      <span className="flex flex-wrap justify-end gap-3 text-xs">
                        {r.status === "draft" && manage && <button type="button" className="text-link-color hover:underline" aria-label={`Edit ${r.name}`} onClick={() => setDialog({ kind: "edit", requirement: r })}>Edit</button>}
                        {r.status === "draft" && approve && <button type="button" className="text-link-color hover:underline" aria-label={`Approve ${r.name}`} onClick={() => setDialog({ kind: "approve", requirement: r })}>Approve</button>}
                        {(r.status === "draft" || r.status === "approved") && manage && <button type="button" className="text-secondary-text hover:underline" aria-label={`Retire ${r.name}`} onClick={() => setDialog({ kind: "retire", requirement: r })}>Retire</button>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </MenuCard>
      )}
      {dialog?.kind === "edit" && <RequirementDialog requirement={dialog.requirement} approved={approvedQuery.data ?? []} onClose={close} />}
      {(dialog?.kind === "approve" || dialog?.kind === "retire") && <NoteDialog requirement={dialog.requirement} kind={dialog.kind} onClose={close} />}
    </div>
  );
};

export default RequirementsPage;
