import { useState } from "react";
import { PencilIcon, PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useDocumentMutation, useDocumentTypes, useToggleDocumentType } from "../../hooks/useDocuments";
import { cleanPrefix, CONTENT_KINDS, contentKindLabel, prefixProblem } from "../../lib/documents";
import { ErrorNotice, FormError } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";

/** Add or change a document type. The prefix is fixed once a document of the type exists. */
const TypeDialog = ({ existing, onClose }) => {
  const mutation = useDocumentMutation();
  const { showToast } = useToast();
  const [name, setName] = useState(existing?.name ?? "");
  const [prefix, setPrefix] = useState(existing?.prefix ?? "");
  const [reviewMonths, setReviewMonths] = useState(String(existing?.reviewMonths ?? 24));
  const [contentHint, setContentHint] = useState(existing?.contentHint ?? "file");
  const [description, setDescription] = useState(existing?.description ?? "");
  const prefixFixed = (existing?.documents ?? 0) > 0;
  const months = Number(reviewMonths);
  const problem = prefixProblem(prefix);
  const ready = name.trim() && !problem && Number.isInteger(months) && months >= 1 && months <= 120;
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { name: name.trim(), reviewMonths: months, contentHint, description: description.trim() || null };
    if (!prefixFixed) body.prefix = prefix;
    mutation.mutate(existing ? { action: "updateType", id: existing.id, body } : { action: "createType", body }, {
      onSuccess: onClose,
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });
  };
  return (
    <Dialog title={existing ? `Edit ${existing.name}` : "New document type"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Drawing" />
        <Field
          label="Prefix"
          value={prefix}
          onChange={(e) => setPrefix(cleanPrefix(e.target.value))}
          required
          disabled={prefixFixed}
          maxLength={10}
          placeholder="e.g. DWG"
          hint={prefixFixed ? "Fixed: documents of this type already use it" : prefix && !problem ? `Documents are numbered ${prefix}-001, ${prefix}-002 …` : problem}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Review every (months)" type="number" min="1" max="120" value={reviewMonths} onChange={(e) => setReviewMonths(e.target.value)} required />
          <ComboField label="Usually" required value={contentHint} onChange={(v) => setContentHint(v ?? "file")} options={CONTENT_KINDS} hint="Suggested when a document is created" />
        </div>
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} hint="Optional" />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!ready || mutation.isPending} loading={mutation.isPending}>
            {existing ? "Save" : "Add type"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** Settings → Data Management → Documents: document types (prefix, review interval, usual content, on/off). */
const SettingsDocuments = () => {
  const { can } = usePermissions();
  const canManage = can("documentation.manage");
  const types = useDocumentTypes({ all: true });
  const toggleType = useToggleDocumentType();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);

  if (types.isLoading) return <LoadingScreen />;
  if (types.error) return <ErrorNotice error={types.error} />;
  const list = types.data.data;
  const toggle = (t) =>
    toggleType.mutate({ id: t.id, active: !t.active }, { onError: (err) => showToast({ type: "error", title: "Not changed", message: describeApiError(err) }) });

  return (
    <MenuCard
      title="Document types"
      subtitle="Each type numbers its own documents. A type switched off takes no new documents; its documents stay as they are."
      action={
        canManage && (
          <CTAButton type="main" icon={PlusIcon} onClick={() => setDialog({})}>
            Add type
          </CTAButton>
        )
      }>
      <ul className="-my-3 divide-y divide-border-color" aria-label="Document types">
        {list.map((t) => (
          <li key={t.id} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${t.active ? "" : "opacity-60"}`}>
            <div className="flex min-w-0 flex-col">
              <span className="font-medium text-primary-text">
                {t.name} <span className="ml-1 rounded bg-primary-bg px-1.5 py-0.5 font-mono text-xs text-secondary-text">{t.prefix}</span>
              </span>
              <span className="text-sm text-secondary-text">
                Review every {t.reviewMonths} {t.reviewMonths === 1 ? "month" : "months"} · usually {contentKindLabel(t.contentHint).toLowerCase()} · {t.documents}{" "}
                {t.documents === 1 ? "document" : "documents"}
                {t.description ? ` · ${t.description}` : ""}
              </span>
            </div>
            {canManage && (
              <div className="flex items-center gap-3">
                <Switch checked={t.active} onChange={() => toggle(t)} >
                  <span className="sr-only">{t.active ? `Switch ${t.name} off` : `Switch ${t.name} on`}</span>
                </Switch>
                <CTAButton type="neutral" icon={PencilIcon} aria-label={`Edit ${t.name}`} onClick={() => setDialog({ existing: t })} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {dialog && <TypeDialog existing={dialog.existing} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
};

export default SettingsDocuments;
