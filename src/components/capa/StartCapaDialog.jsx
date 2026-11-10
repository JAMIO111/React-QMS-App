import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import { useCapaMutation } from "../../hooks/useCapa";
import { SEVERITIES, SOURCES } from "../../lib/capa";
import { FormError, TextAreaField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";
import { CustomFieldInputs } from "../custom-fields/CustomFieldsCard";
import { withCustomValues } from "../../lib/customFields";

/** Starts an 8D that is not tied to a non-conformance (to start one from an NC, use the button on the NC page). */
const StartCapaDialog = ({ onClose }) => {
  const navigate = useNavigate();
  const mutation = useCapaMutation();
  const [form, setForm] = useState({ title: "", problemStatement: "", source: "internal", severity: null });
  const [customValues, setCustomValues] = useState({});
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog title="Start an 8D" onClose={onClose} width="max-w-xl">
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(
            { action: "create", body: { title: form.title.trim(), ...(form.problemStatement.trim() ? { problemStatement: form.problemStatement.trim() } : {}), source: form.source, ...(form.severity ? { severity: form.severity } : {}), ...withCustomValues(customValues) } },
            { onSuccess: (capa) => navigate(`/CAPA/${capa.id}/d0`) },
          );
        }}>
        <Field label="Title" value={form.title} onChange={set("title")} required maxLength={200} hint="What is the problem, in one line" />
        <TextAreaField label="Problem statement" value={form.problemStatement} onChange={set("problemStatement")} rows={3} maxLength={5000} hint="Can be written in D0 instead" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RHFComboBox label="Source" value={form.source} onChange={(v) => setForm((f) => ({ ...f, source: v ?? "internal" }))} options={SOURCES} sort={false} clearable={false} />
          <RHFComboBox label="Severity" value={form.severity} onChange={(v) => setForm((f) => ({ ...f, severity: v }))} options={SEVERITIES} sort={false} placeholder="Not set" />
        </div>
        <CustomFieldInputs entityType="capa" values={customValues} onChange={setCustomValues} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending || !form.title.trim()} loading={mutation.isPending}>{mutation.isPending ? "Starting…" : "Start 8D"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

export default StartCapaDialog;
