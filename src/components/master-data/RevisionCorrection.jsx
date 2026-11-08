import { useState } from "react";
import { Link } from "react-router-dom";
import Dialog from "../ui/Dialog";
import LoadingScreen from "../ui/LoadingScreen";
import { useToast } from "../../contexts/ToastProvider";
import { useCorrectionImpact, useMasterDataMutation } from "../../hooks/useMasterData";
import { describeApiError } from "../../lib/api-client";
import { ncrPath } from "../../lib/ncr";
import { revisionLabel } from "../../lib/partRevisions";
import { ErrorNotice, FormError, TextAreaField } from "./shared";
import CTAButton from "@/components/CTAButton";

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

/** Start a correction of the current released revision: the drawing's letter stays, a draft of the next version is made with the same values. */
export const CorrectDialog = ({ revision, onClose }) => {
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const [reason, setReason] = useState("");
  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      { path: `/part-revisions/${revision.id}/correction`, body: { reason: reason.trim() } },
      {
        onSuccess: (draft) => {
          showToast({ type: "success", title: "Correction started", message: `Draft ${revisionLabel(draft)} is ready to edit.` });
          onClose();
        },
      }
    );
  };
  return (
    <Dialog title={`Correct revision ${revisionLabel(revision)}`} onClose={onClose} width="max-w-xl">
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <p className="text-sm text-primary-text">
          Use this when the drawing and our record of revision <strong>{revision.revision}</strong> disagree. The revision stays <strong>{revision.revision}</strong>: this makes a draft
          of the next version with the same values for you to correct. When it is approved and released it replaces {revisionLabel(revision)}, which stays on record, marked corrected.
          Inspections already run keep the version they used.
        </p>
        <TextAreaField label="What is wrong in the system, compared with the drawing?" required rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!reason.trim() || mutation.isPending}>
            {mutation.isPending ? "Starting…" : "Start correction"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Approve and release a correction: says what it replaces and how much has run on the version being replaced. */
export const ReleaseCorrectionDialog = ({ revision, onClose }) => {
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const impact = useCorrectionImpact(revision.id);
  const d = impact.data;
  const running = d?.inspections.filter((i) => i.status === "in_progress").length ?? 0;
  const approve = () =>
    mutation.mutate(
      { path: `/part-revisions/${revision.id}/release` },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Correction released", message: `Revision ${revisionLabel(revision)} is now the released version.` });
          onClose();
        },
        onError: (error) => showToast({ type: "error", title: "Not released", message: describeApiError(error) }),
      }
    );
  return (
    <Dialog title={`Approve and release ${revisionLabel(revision)}`} onClose={onClose} width="max-w-xl">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-primary-text">
          Revision {revision.revision} v{d?.corrected.version ?? revision.version - 1} will be marked <strong>corrected</strong> and kept, and {revisionLabel(revision)} becomes the released version.
          New inspections use it from now on.
        </p>
        {revision.correctionReason && <p className="rounded-lg border border-border-color bg-primary-bg p-3 text-sm text-primary-text">Reason: {revision.correctionReason}</p>}
        {impact.isLoading && <LoadingScreen size="sm" />}
        {impact.error && <ErrorNotice error={impact.error} />}
        {d && (
          <div aria-label="What used the version being replaced" className="text-sm text-primary-text">
            {!d.canReadInspections && !d.canReadNcrs ? (
              <p className="text-secondary-text">You do not have access to inspections or non-conformances, so what used the earlier version is not shown.</p>
            ) : (
              <ul className="list-disc pl-5">
                {d.canReadInspections && (
                  <li>
                    {plural(d.inspectionsTotal, "inspection", "inspections")} used it{running > 0 ? `, ${running} still running` : ""}. They keep it.
                  </li>
                )}
                {d.canReadNcrs && <li>{plural(d.ncrsTotal, "non-conformance", "non-conformances")} refer to it. They keep it.</li>}
              </ul>
            )}
            <p className="mt-1 text-xs text-secondary-text">The full list is on the part page once the correction is released. Nothing is changed or raised for you.</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="button" type="main" size="lg" onClick={approve} disabled={mutation.isPending || impact.isLoading}>
            {mutation.isPending ? "Releasing…" : "Approve and release"}
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** After a correction: the version that was replaced, why, and the inspections and non-conformances that used it, for review. Information only. */
export const CorrectionImpactCard = ({ part }) => {
  const corrected = [...part.revisions].filter((r) => r.status === "corrected").sort((a, b) => (b.correctedAt ?? "").localeCompare(a.correctedAt ?? ""))[0];
  const impact = useCorrectionImpact(corrected?.id, { enabled: !!corrected });
  if (!corrected) return null;
  const d = impact.data;
  const replacement = d?.correction;
  const th = "border-b border-border-color px-2 py-1.5 text-left font-normal text-secondary-text";
  const td = "border-b border-border-color px-2 py-1.5";
  return (
    <section aria-labelledby="correction-impact-title" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-5">
      <div>
        <h2 id="correction-impact-title" className="text-lg font-semibold text-primary-text">
          Revision {corrected.revision} was corrected
        </h2>
        <p className="text-sm text-secondary-text">
          {revisionLabel(corrected)} was replaced on {formatDate(corrected.correctedAt)}
          {replacement?.reason ? `: ${replacement.reason}` : ""}. It stays on record. Work that used it is listed here to review; nothing was changed for you.
        </p>
      </div>
      {impact.isLoading && <LoadingScreen size="sm" />}
      {impact.error && <ErrorNotice error={impact.error} />}
      {d && (
        <>
          {d.canReadInspections ? (
            d.inspections.length === 0 ? (
              <p className="text-sm text-secondary-text">No inspections used {revisionLabel(corrected)}.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Inspections that used the earlier version">
                  <thead>
                    <tr>
                      <th scope="col" className={th}>Inspection</th>
                      <th scope="col" className={th}>Status</th>
                      <th scope="col" className={th}>Result</th>
                      <th scope="col" className={th}>Started</th>
                      <th scope="col" className={th}>Operator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.inspections.map((i) => (
                      <tr key={i.id}>
                        <td className={td}>
                          <Link to={`/Inspections/${i.id}`} className="text-link-color hover:underline">
                            {i.reference}
                          </Link>
                        </td>
                        <td className={`${td} capitalize`}>{i.status.replace("_", " ")}</td>
                        <td className={`${td} capitalize`}>{i.result ?? "—"}</td>
                        <td className={td}>{formatDate(i.startedAt)}</td>
                        <td className={td}>{i.startedBy ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.inspectionsTotal > d.inspections.length && <p className="mt-1 text-xs text-secondary-text">Showing {d.inspections.length} of {d.inspectionsTotal}.</p>}
              </div>
            )
          ) : (
            <p className="text-sm text-secondary-text">You do not have access to inspections, so they are not listed.</p>
          )}
          {d.canReadNcrs ? (
            d.ncrs.length === 0 ? (
              <p className="text-sm text-secondary-text">No non-conformances refer to {revisionLabel(corrected)}.</p>
            ) : (
              <ul aria-label="Non-conformances that refer to the earlier version" className="flex flex-col gap-1 text-sm">
                {d.ncrs.map((n) => (
                  <li key={n.id}>
                    <Link to={ncrPath(n.id)} className="text-link-color hover:underline">
                      {n.reference}
                    </Link>{" "}
                    · {n.title} <span className="text-secondary-text">({n.stage.replace("_", " ")}, {formatDate(n.detectedAt)})</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="text-sm text-secondary-text">You do not have access to non-conformances, so they are not listed.</p>
          )}
        </>
      )}
    </section>
  );
};
