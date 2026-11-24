import { useParams } from "react-router-dom";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import { useChange } from "../../hooks/useChange";
import { describeApiError } from "../../lib/api-client";
import { changePath, customerLabel, cutInWords, formatDay, impactLabel, linkKindLabel, linkWords, signoffLabel, stageLabel, stockLabel } from "../../lib/change";

/** The change as one printable notice (`/Change/:id/notice`): what, why, impact, who agreed, from when, what the customer said. "Print or save as PDF" prints only the notice. */
const ChangeNoticePage = () => {
  const { id } = useParams();
  const { data: c, isLoading, error } = useChange(id);
  if (isLoading) return <LoadingScreen />;
  if (error || !c)
    return (
      <div className="p-4">
        <Callout tone="error" role="alert">
          {describeApiError(error)}
        </Callout>
      </div>
    );
  const h2 = "mt-6 border-b border-border-color pb-1 text-lg font-semibold text-primary-text";
  const affected = c.impacts.filter((i) => i.status === "affected");
  const notAffected = c.impacts.filter((i) => i.status === "not_affected");
  const open = c.impacts.filter((i) => i.status === "not_assessed");
  const latest = c.signoffs.filter((s) => s.round === c.reviewRound);
  // a change the board approved stays an ECN while it is carried out, checked and after it is closed
  const approved = ["approved", "implementing", "verifying", "closed"].includes(c.stage);
  const cut = cutInWords(c.cutIn);
  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <style>{"@media print { body * { visibility: hidden !important; } #change-notice, #change-notice * { visibility: visible !important; } #change-notice { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; box-shadow: none; } }"}</style>
      <div className="flex flex-wrap gap-2">
        <CTAButton type="neutral" size="md" to={changePath(c.id)}>
          Back to the change
        </CTAButton>
        <CTAButton buttonType="button" type="secondary" size="md" onClick={() => window.print()}>
          Print or save as PDF
        </CTAButton>
      </div>
      <article id="change-notice" aria-label="Change notice" className="mx-auto w-full max-w-4xl rounded-2xl bg-secondary-bg p-8 text-sm text-primary-text shadow">
        <header className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-secondary-text">{approved ? "Engineering change notice" : "Engineering change request"}</p>
          <h1 className="text-2xl font-semibold">
            {c.reference} · {c.title}
          </h1>
          <p className="text-secondary-text">
            {stageLabel(c.stage)} · {c.type.label}
            {c.urgency === "expedited" ? " · expedited" : ""} · raised {formatDay(c.createdAt)} by {c.raisedBy?.name ?? "unknown"}
            {approved ? ` · approved ${formatDay(c.approvedAt)}${c.approvedBy ? ` by ${c.approvedBy}` : ""}` : ""}
          </p>
          {!approved && <p className="font-medium text-warning-color">Not approved: this is a draft of the notice.</p>}
        </header>

        <h2 className={h2}>What is changing</h2>
        <p className="mt-2 whitespace-pre-wrap">{c.description ?? "—"}</p>
        <h2 className={h2}>Why</h2>
        <p className="mt-2 whitespace-pre-wrap">{c.reason ?? "—"}</p>

        <h2 className={h2}>What it covers</h2>
        {c.links.length ? (
          <ul className="mt-2 list-disc pl-5">
            {c.links.map((l) => (
              <li key={`${l.kind}:${l.id ?? l.code}`}>
                {linkKindLabel(l.kind)}: {linkWords(l)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-secondary-text">Nothing named.</p>
        )}

        <h2 className={h2}>Impact</h2>
        {c.impacts.length === 0 ? (
          <p className="mt-2 text-secondary-text">Not assessed yet.</p>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {affected.length > 0 && (
              <ul aria-label="Affected areas" className="list-disc pl-5">
                {affected.map((i) => (
                  <li key={i.id}>
                    <span className="font-medium">{i.label}</span>: {i.note}
                  </li>
                ))}
              </ul>
            )}
            {notAffected.length > 0 && <p className="text-secondary-text">{impactLabel("not_affected")}: {notAffected.map((i) => i.label).join(", ")}.</p>}
            {open.length > 0 && <p className="text-warning-color">Not assessed: {open.map((i) => i.label).join(", ")}.</p>}
          </div>
        )}

        <h2 className={h2}>Who agreed</h2>
        {latest.length === 0 ? (
          <p className="mt-2 text-secondary-text">Not with the board yet.</p>
        ) : (
          <ul className="mt-2 list-disc pl-5">
            {latest.map((s) => (
              <li key={s.id}>
                <span className="font-medium">{s.function.label}</span>, {s.signer?.name ?? "unknown"}: {signoffLabel(s.status).toLowerCase()}
                {s.decidedAt ? ` on ${formatDay(s.decidedAt)}` : ""}
                {s.comment ? ` — “${s.comment}”` : ""}
              </li>
            ))}
          </ul>
        )}

        <h2 className={h2}>From when</h2>
        <p className="mt-2">{cut ?? "No fixed point."}</p>
        {(c.cutIn.stockAction || c.cutIn.stockNote) && (
          <p className="mt-1 whitespace-pre-wrap">Stock already made: {[stockLabel(c.cutIn.stockAction), c.cutIn.stockNote].filter(Boolean).join(" — ")}</p>
        )}

        <h2 className={h2}>Customer</h2>
        <p className="mt-2">
          {customerLabel(c.customerApproval.status)}
          {c.customerApproval.reference ? ` · their reference ${c.customerApproval.reference}` : ""}
          {c.customerApproval.on ? ` · ${formatDay(c.customerApproval.on)}` : ""}
          {c.customerApproval.waivedReason ? ` · waived: ${c.customerApproval.waivedReason}` : ""}
        </p>
      </article>
    </div>
  );
};

export default ChangeNoticePage;
