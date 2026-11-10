import { useEffect, useState } from "react";
import { revisionLabel } from "../../lib/partRevisions";
import { PencilIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { useUnits } from "../../hooks/useMasterData";
import { useProcessControlMutation, useSpecValues } from "../../hooks/useProcessControl";
import { describeApiError } from "../../lib/api-client";
import { FormError, SelectField } from "./shared";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2";
const show = (v) => (v === null || v === undefined ? "—" : String(v));
const toNumber = (v) => (String(v).trim() === "" ? null : Number(v));

const SpecValueForm = ({ revision, value, onDone }) => {
  const mutation = useProcessControlMutation();
  const units = useUnits();
  const { showToast } = useToast();
  const [form, setForm] = useState({
    characteristicKey: value?.characteristicKey ?? "",
    description: value?.description ?? "",
    nominal: value?.nominal ?? "",
    lowerLimit: value?.lowerLimit ?? "",
    upperLimit: value?.upperLimit ?? "",
    unitCode: value?.unitCode ?? "mm",
    notes: value?.notes ?? "",
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [problem, setProblem] = useState(null);

  const submit = (e) => {
    e.preventDefault();
    const nums = { nominal: toNumber(form.nominal), lowerLimit: toNumber(form.lowerLimit), upperLimit: toNumber(form.upperLimit) };
    if (Object.values(nums).some((n) => n !== null && Number.isNaN(n))) return setProblem("Nominal and limits must be numbers.");
    if (Object.values(nums).every((n) => n === null)) return setProblem("Give a nominal or at least one limit.");
    setProblem(null);
    const body = { description: form.description.trim(), ...nums, unitCode: form.unitCode, notes: form.notes.trim() };
    mutation.mutate(
      value
        ? { path: `/part-revision-characteristics/${value.id}`, method: "PATCH", body }
        : { path: `/part-revisions/${revision.id}/characteristics`, body: { characteristicKey: form.characteristicKey.trim(), ...body } },
      {
        onSuccess: (saved) => {
          showToast({ type: "success", title: "Saved", message: `${saved.characteristicKey} saved on revision ${revisionLabel(revision)}.` });
          onDone();
        },
      }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Characteristic key"
          value={form.characteristicKey}
          onChange={set("characteristicKey")}
          required
          disabled={!!value}
          maxLength={40}
          hint={value ? "Keys cannot be renamed" : "Links control plan checks to this value, e.g. LENGTH"}
        />
        <Field label="Description" value={form.description} onChange={set("description")} maxLength={200} />
        <Field label="Nominal" inputMode="decimal" value={form.nominal} onChange={set("nominal")} />
        <SelectField
          label="Unit"
          required
          value={form.unitCode}
          onChange={(v) => setForm((f) => ({ ...f, unitCode: v }))}
          options={(units.data ?? []).map((u) => ({ value: u.code, label: `${u.code} · ${u.name}` }))}
        />
        <Field label="Lower limit (LSL)" inputMode="decimal" value={form.lowerLimit} onChange={set("lowerLimit")} hint="Leave empty for a maximum only" />
        <Field label="Upper limit (USL)" inputMode="decimal" value={form.upperLimit} onChange={set("upperLimit")} hint="Leave empty for a minimum only" />
      </div>
      <Field label="Notes" value={form.notes} onChange={set("notes")} maxLength={1000} />
      {problem && (
        <p role="alert" className="text-sm text-error-color">
          {problem}
        </p>
      )}
      <FormError error={mutation.error} />
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save value"}
        </CTAButton>
      </div>
    </form>
  );
};

/**
 * Part-specific characteristic values of one revision (its specification). Variable checks in a
 * family control plan take their nominal and limits from here. Only draft revisions are editable;
 * a new draft starts with the released revision's values.
 */
const SpecValues = ({ part, canManage }) => {
  const revisions = part.revisions;
  const preferred = revisions.find((r) => r.status === "draft") ?? revisions.find((r) => r.status === "released") ?? revisions[0];
  const [revisionId, setRevisionId] = useState(preferred?.id ?? null);
  useEffect(() => {
    if (!revisions.some((r) => r.id === revisionId)) setRevisionId(preferred?.id ?? null);
  }, [revisions, revisionId, preferred]);
  // A newly added draft is where values are edited next, so show it.
  const draftId = revisions.find((r) => r.status === "draft")?.id ?? null;
  useEffect(() => {
    if (draftId) setRevisionId(draftId);
  }, [draftId]);
  const revision = revisions.find((r) => r.id === revisionId);
  const { data: values, isLoading, error } = useSpecValues(revisionId);
  const editable = canManage && revision?.status === "draft";
  const [editing, setEditing] = useState(null); // null | "new" | value
  const mutation = useProcessControlMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();

  const remove = async (v) => {
    const ok = await confirm({
      title: `Remove ${v.characteristicKey}?`,
      message: `It is removed from draft revision ${revisionLabel(revision)} only.`,
      confirmText: "Remove",
      cancelText: "Cancel",
      type: "warning",
    });
    if (!ok) return;
    mutation.mutate(
      { path: `/part-revision-characteristics/${v.id}`, method: "DELETE" },
      { onError: (err) => showToast({ type: "error", title: "Not removed", message: describeApiError(err) }) }
    );
  };

  return (
    <MenuCard
      title="Specification values"
      subtitle="Part-specific nominals and limits per revision, used by variable checks in family control plans."
      bodyClassName="flex flex-col gap-3"
      action={
        editable && (
          <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setEditing("new")}>
            <PlusIcon className="h-4 w-4" /> Add value
          </CTAButton>
        )
      }>
      {revisions.length === 0 ? (
        <p className="text-sm text-secondary-text">Add a revision first.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              label="Revision"
              required
              value={revisionId}
              onChange={setRevisionId}
              options={revisions.map((r) => ({ value: r.id, label: `${revisionLabel(r)} · ${r.status}` }))}
              className="w-48"
            />
            {revision && revision.status !== "draft" && (
              <p className="pb-2 text-xs text-secondary-text">
                Revision {revisionLabel(revision)} is {revision.status}; its values are locked. {revision.status === "corrected" ? "It was replaced by a correction." : "Add a new revision, or correct the released one, to change them."}
              </p>
            )}
          </div>
          {isLoading && <LoadingScreen size="sm" />}
          {error && <FormError error={error} />}
          {values && values.length === 0 && <p className="text-sm text-secondary-text">No values on this revision.</p>}
          {values && values.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm text-primary-text" aria-label={`Specification values of revision ${revision?.revision}`}>
                <thead>
                  <tr>
                    <th scope="col" className={th}>Key</th>
                    <th scope="col" className={th}>Description</th>
                    <th scope="col" className={`${th} text-right`}>LSL</th>
                    <th scope="col" className={`${th} text-right`}>Nominal</th>
                    <th scope="col" className={`${th} text-right`}>USL</th>
                    <th scope="col" className={th}>Unit</th>
                    {editable && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {values.map((v) => (
                    <tr key={v.id}>
                      <td className={`${td} font-mono`}>{v.characteristicKey}</td>
                      <td className={td}>{v.description ?? "—"}</td>
                      <td className={`${td} text-right tabular-nums`}>{show(v.lowerLimit)}</td>
                      <td className={`${td} text-right tabular-nums`}>{show(v.nominal)}</td>
                      <td className={`${td} text-right tabular-nums`}>{show(v.upperLimit)}</td>
                      <td className={td}>{v.unitCode}</td>
                      {editable && (
                        <td className={td}>
                          <div className="flex justify-end gap-2">
                            <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setEditing(v)} aria-label={`Edit ${v.characteristicKey}`}>
                              <PencilIcon className="h-4 w-4" />
                            </CTAButton>
                            <CTAButton buttonType="button" type="danger" size="md" disabled={mutation.isPending} loading={mutation.isPending} onClick={() => remove(v)} aria-label={`Remove ${v.characteristicKey}`}>
                              <Trash2Icon className="h-4 w-4" />
                            </CTAButton>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {editing && revision && (
        <Dialog title={editing === "new" ? `Add value to revision ${revisionLabel(revision)}` : `Edit ${editing.characteristicKey}`} onClose={() => setEditing(null)}>
          <SpecValueForm revision={revision} value={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
        </Dialog>
      )}
    </MenuCard>
  );
};

export default SpecValues;
