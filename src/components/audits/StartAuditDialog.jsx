import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../../contexts/ToastProvider";
import { useAudits, useAuditMutation } from "../../hooks/useAudits";
import { auditTypeLabel } from "../../lib/audits";
import Dialog from "../ui/Dialog";
import { FormError, SelectField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

/** Start an audit that is not tied to a scheduled slot: choose which audit, and the record opens ready to be answered. */
const StartAuditDialog = ({ onClose }) => {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const audits = useAudits({ status: "active", sort: "title", pageSize: 200 });
  const mutation = useAuditMutation();
  const [auditId, setAuditId] = useState(null);
  const options = (audits.data?.data ?? []).map((a) => ({ value: a.id, label: `${a.reference} · ${a.title}` }));
  const chosen = audits.data?.data.find((a) => a.id === auditId);

  return (
    <Dialog title="Start an audit" onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(
            { path: "/audit-records", body: { auditId } },
            {
              onSuccess: (record) => {
                showToast({ type: "success", title: "Audit started", message: `${record.reference} is open.` });
                navigate(`/Documentation/Audit-Records/${record.id}`);
              },
            }
          );
        }}
        className="flex flex-col gap-3">
        <SelectField label="Audit" required value={auditId} onChange={setAuditId} options={options} placeholder={audits.isLoading ? "Loading…" : "Choose an audit"} />
        {chosen && (
          <p className="text-sm text-secondary-text">
            {auditTypeLabel(chosen.auditType)}; {chosen.questionCount} {chosen.questionCount === 1 ? "question" : "questions"}
            {chosen.criticalCount ? `, ${chosen.criticalCount} critical` : ""}. Pass mark {chosen.passMark}%.
          </p>
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" onClick={onClose} type="neutral" size="md">
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" disabled={!auditId || mutation.isPending} type="main" size="lg">
            {mutation.isPending ? "Starting…" : "Start audit"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default StartAuditDialog;
