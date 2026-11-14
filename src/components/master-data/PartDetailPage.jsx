import CustomFieldsCard from "../custom-fields/CustomFieldsCard";
import { useEffect, useState } from "react";
import Switch from "@/components/ui/Switch";
import { Link, useParams } from "react-router-dom";
import { ArrowLeftIcon, PlusIcon } from "@/components/icons";
import Field from "../ui/Field";
import Dialog from "../ui/Dialog";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useMasterDataMutation, usePart } from "../../hooks/useMasterData";
import { describeApiError } from "../../lib/api-client";
import { ActiveBadge, ErrorNotice, SelectField } from "./shared";
import { usePartFamilies } from "../../hooks/useProcessControl";
import SpecValues from "./SpecValues";
import ActiveAlertsBanner from "../documentation/ActiveAlertsBanner";
import DocumentsInForce from "../documents/DocumentsInForce";

import PartCustomers from "./PartCustomers";
import { CorrectDialog, CorrectionImpactCard, ReleaseCorrectionDialog } from "./RevisionCorrection";
import { currentRevisionLabel, revisionLabel } from "../../lib/partRevisions";
import RequirementPreview from "../process-control/RequirementPreview";
import FeatureMapsCard from "../measurement-imports/FeatureMapsCard";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";

const STATUS_STYLE = {
  draft: "bg-warning-color/15 text-primary-text",
  released: "bg-success-color/15 text-success-color",
  superseded: "bg-border-color text-secondary-text",
  obsolete: "bg-border-color text-secondary-text line-through",
  corrected: "bg-border-color text-secondary-text",
};
const StatusPill = ({ status }) => (
  <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${STATUS_STYLE[status]}`}>{status}</span>
);

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const PartDetails = ({ part, canManage }) => {
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const families = usePartFamilies();
  const toForm = (p) => ({
    partNumber: p.partNumber,
    name: p.name,
    description: p.description ?? "",
    partFamilyId: p.partFamily?.id ?? null,
    active: p.active,
  });
  const [form, setForm] = useState(toForm(part));
  useEffect(() => setForm(toForm(part)), [part]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      {
        path: `/parts/${part.id}`,
        method: "PATCH",
        body: {
          partNumber: form.partNumber.trim(),
          name: form.name.trim(),
          description: form.description.trim(),
          partFamilyId: form.partFamilyId,
          active: form.active,
        },
      },
      { onSuccess: () => showToast({ type: "success", title: "Saved", message: "Part updated." }) }
    );
  };

  return (
    <form onSubmit={submit} aria-label="Part details" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Part number" value={form.partNumber} onChange={set("partNumber")} disabled={!canManage} required maxLength={60} />
        <Field label="Name" value={form.name} onChange={set("name")} disabled={!canManage} required maxLength={200} />
        <Field label="Description" value={form.description} onChange={set("description")} disabled={!canManage} maxLength={2000} className="md:col-span-2" />
        {canManage ? (
          <SelectField
            label="Part family"
            value={form.partFamilyId}
            onChange={(v) => setForm((f) => ({ ...f, partFamilyId: v }))}
            options={(families.data?.items ?? [])
              .concat(part.partFamily && !(families.data?.items ?? []).some((f) => f.id === part.partFamily.id) ? [part.partFamily] : [])
              .map((f) => ({ value: f.id, label: `${f.code} · ${f.name}` }))}
            hint="Family control plans apply to this part"
          />
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-secondary-text">Part family</span>
            <p className="py-2 text-primary-text">{part.partFamily ? `${part.partFamily.code} · ${part.partFamily.name}` : "—"}</p>
          </div>
        )}
        {canManage && (
          <Switch className="self-end pb-2 text-sm text-primary-text" checked={form.active} onChange={set("active")}>
            Active
          </Switch>
        )}
      </div>
      {mutation.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(mutation.error)}
        </p>
      )}
      {canManage && (
        <CTAButton buttonType="submit" type="main" size="lg" className="self-start" disabled={mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save changes"}
        </CTAButton>
      )}
    </form>
  );
};

const RevisionForm = ({ part, revision, onDone }) => {
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const [form, setForm] = useState({ revision: revision?.revision ?? "", drawingRef: revision?.drawingRef ?? "", changeSummary: revision?.changeSummary ?? "" });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    const body = { revision: form.revision.trim(), drawingRef: form.drawingRef.trim(), changeSummary: form.changeSummary.trim() };
    mutation.mutate(
      revision ? { path: `/part-revisions/${revision.id}`, method: "PATCH", body } : { path: `/parts/${part.id}/revisions`, body },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: revision ? "Draft revision updated." : `Draft revision ${body.revision} added.` });
          onDone();
        },
      }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Revision" value={form.revision} onChange={set("revision")} required maxLength={10} hint="e.g. A, B, 02" />
        <Field label="Drawing reference" value={form.drawingRef} onChange={set("drawingRef")} maxLength={100} />
      </div>
      <Field label="What changed" value={form.changeSummary} onChange={set("changeSummary")} maxLength={2000} />
      {mutation.error && (
        <p role="alert" className="text-sm text-error-color">
          {describeApiError(mutation.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <CTAButton buttonType="button" type="neutral" size="md" onClick={onDone}>
          Cancel
        </CTAButton>
        <CTAButton buttonType="submit" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? "Saving…" : revision ? "Save draft" : "Add draft revision"}
        </CTAButton>
      </div>
    </form>
  );
};

const Revisions = ({ part, canManage }) => {
  const mutation = useMasterDataMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const { can } = usePermissions();
  const canApprove = can("process_control.approve");
  const [editing, setEditing] = useState(null); // null | "new" | revision
  const [correcting, setCorrecting] = useState(null); // the released revision being corrected
  const [approving, setApproving] = useState(null); // the correction draft being approved
  const current = part.revisions.find((r) => r.status === "released");
  const openCorrection = current && part.revisions.find((r) => r.status === "draft" && r.correctsId === current.id);

  const transition = async (rev, action) => {
    const releasing = action === "release";
    const ok = await confirm({
      title: releasing ? `Release revision ${rev.revision}?` : rev.correctsId && rev.status === "draft" ? `Discard the correction ${revisionLabel(rev)}?` : `Make revision ${rev.revision} obsolete?`,
      message: releasing
        ? `It becomes the current revision and can no longer be edited.${current ? ` Revision ${current.revision} will be superseded.` : ""}`
        : rev.correctsId && rev.status === "draft"
          ? `The draft is dropped. Revision ${rev.revision} v${rev.version - 1} stays the released version.`
          : "It will no longer be used for new inspections or records. This cannot be undone.",
      confirmText: releasing ? "Release" : rev.correctsId && rev.status === "draft" ? "Discard" : "Make obsolete",
      cancelText: "Cancel",
      type: "warning",
    });
    if (!ok) return;
    mutation.mutate(
      { path: `/part-revisions/${rev.id}/${action}` },
      {
        onSuccess: () => showToast({ type: "success", title: "Saved", message: releasing ? `Revision ${rev.revision} released.` : rev.correctsId && rev.status === "draft" ? `Correction ${revisionLabel(rev)} discarded.` : `Revision ${rev.revision} is obsolete.` }),
        onError: (error) => showToast({ type: "error", title: "Not changed", message: describeApiError(error) }),
      }
    );
  };

  return (
    <section aria-labelledby="revisions-title" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="revisions-title" className="text-lg font-semibold text-primary-text">
          Revisions
        </h2>
        {canManage && (
          <CTAButton buttonType="button" type="neutral" size="md" className="flex items-center gap-1" onClick={() => setEditing("new")}>
            <PlusIcon className="h-4 w-4" /> Add revision
          </CTAButton>
        )}
      </div>
      {part.revisions.length === 0 ? (
        <p className="text-sm text-secondary-text">No revisions yet. Add one, then release it when the drawing is approved.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Revisions">
            <thead>
              <tr className="text-left text-secondary-text">
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">Revision</th>
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">Status</th>
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">Drawing</th>
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">What changed</th>
                <th scope="col" className="border-b border-border-color px-2 py-2 font-normal">Released</th>
                {canManage && <th scope="col" className="border-b border-border-color px-2 py-2 font-normal"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {part.revisions.map((r) => (
                <tr key={r.id}>
                  <td className="border-b border-border-color px-2 py-2 font-mono">{revisionLabel(r)}</td>
                  <td className="border-b border-border-color px-2 py-2"><StatusPill status={r.status} /></td>
                  <td className="border-b border-border-color px-2 py-2">{r.drawingRef ?? "—"}</td>
                  <td className="border-b border-border-color px-2 py-2">
                    {r.changeSummary ?? "—"}
                    {r.correctsId && <span className="mt-0.5 block text-xs text-secondary-text">Correction of {r.revision} v{r.version - 1}: {r.correctionReason}</span>}
                    {r.status === "corrected" && <span className="mt-0.5 block text-xs text-secondary-text">Replaced {formatDate(r.correctedAt)} by a correction</span>}
                  </td>
                  <td className="border-b border-border-color px-2 py-2">{formatDate(r.releasedAt)}</td>
                  {canManage && (
                    <td className="border-b border-border-color px-2 py-2">
                      <div className="flex justify-end gap-2">
                        {r.status === "draft" && (
                          <>
                            <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setEditing(r)} aria-label={`Edit revision ${revisionLabel(r)}`}>
                              Edit
                            </CTAButton>
                            {r.correctsId ? (
                              canApprove ? (
                                <CTAButton buttonType="button" type="main" size="lg" onClick={() => setApproving(r)} disabled={mutation.isPending} loading={mutation.isPending}>
                                  Approve and release
                                </CTAButton>
                              ) : (
                                <span className="self-center text-xs text-secondary-text">Needs approval</span>
                              )
                            ) : (
                              <CTAButton buttonType="button" type="main" size="lg" onClick={() => transition(r, "release")} disabled={mutation.isPending} loading={mutation.isPending}>
                                Release
                              </CTAButton>
                            )}
                          </>
                        )}
                        {r.status === "released" && !openCorrection && (
                          <CTAButton buttonType="button" type="secondary" size="md" onClick={() => setCorrecting(r)} aria-label={`Correct revision ${revisionLabel(r)}`}>
                            Correct
                          </CTAButton>
                        )}
                        {r.status !== "obsolete" && r.status !== "corrected" && (
                          <CTAButton buttonType="button" type="danger" size="md" onClick={() => transition(r, "obsolete")} disabled={mutation.isPending} loading={mutation.isPending} aria-label={`${r.correctsId && r.status === "draft" ? "Discard correction" : "Make revision"} ${revisionLabel(r)}${r.correctsId && r.status === "draft" ? "" : " obsolete"}`}>
                            {r.correctsId && r.status === "draft" ? "Discard" : "Obsolete"}
                          </CTAButton>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {correcting && <CorrectDialog revision={correcting} onClose={() => setCorrecting(null)} />}
      {approving && <ReleaseCorrectionDialog revision={approving} onClose={() => setApproving(null)} />}
      {editing && (
        <Dialog title={editing === "new" ? "Add revision" : `Edit draft revision ${editing.revision}`} onClose={() => setEditing(null)}>
          <RevisionForm part={part} revision={editing === "new" ? null : editing} onDone={() => setEditing(null)} />
        </Dialog>
      )}
    </section>
  );
};

const PartDetailPage = () => {
  const { id } = useParams();
  const { can } = usePermissions();
  const canManage = can("master_data.manage");
  const { data: part, isLoading, error } = usePart(id);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to="/Parts" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Parts
      </Link>
      {isLoading && <LoadingScreen />}
      {error && <ErrorNotice error={error} />}
      {part && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-primary-text">
              {part.partNumber} <span className="font-normal text-secondary-text">· {part.name}</span>
            </h1>
            <ActiveBadge active={part.active} />
            <span className="text-sm text-secondary-text">
              Current revision: <strong className="font-mono text-primary-text">{currentRevisionLabel(part) ?? "none released"}</strong>
            </span>
          </div>
          <ActiveAlertsBanner partId={part.id} />
          <DocumentsInForce partId={part.id} />
          <PartDetails part={part} canManage={canManage} />
          <CustomFieldsCard entityType="part" record={part} editable={canManage} />
          <PartCustomers part={part} canManage={canManage} />
          <Revisions part={part} canManage={canManage} />
          <CorrectionImpactCard part={part} />
          <SpecValues part={part} canManage={canManage} />
          {can("process_control.read") && (
            <RequirementPreview
              key={part.id}
              partId={part.id}
              title="Inspection requirements"
              subtitle="The control plan that applies to this part and what is checked, from its released revision."
            />
          )}
          {(can("process_control.read") || can("inspection.read")) && (
            <FeatureMapsCard partId={part.id} canEdit={can("process_control.manage") || can("inspection.record")} />
          )}
        </>
      )}
    </div>
  );
};

export default PartDetailPage;
