import { Link } from "react-router-dom";
import { usePartPpapState, usePpapPrompts } from "../../hooks/usePpap";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDate } from "../../lib/ncr";
import { ppapPath, statusLabel, supplierPpapLabel, supplierPpapPill } from "../../lib/ppap";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import { useRaisePpap } from "./useRaisePpap";

const TONE = { info: "info", warning: "warning", critical: "error" };

/**
 * What the part's PPAP says where the work happens (PP14): a revision with no PPAP for a customer that requires one, one being prepared or waiting for them, a rejection, an
 * interim approval that is ending or has run out, a part not made for a year. INFORMATION ONLY: it never blocks anything, and nothing shows to someone who may not read PPAPs.
 */
export const PartPpapBanner = ({ partId, partRevisionId, className = "" }) => {
  const { can } = usePermissions();
  const query = usePartPpapState(partId, partRevisionId, { enabled: can("ppap.read") });
  if (!can("ppap.read") || !query.data?.available || !query.data.attention?.length) return null;
  const items = query.data.attention;
  const worst = items.some((a) => a.tone === "critical") ? "critical" : items.some((a) => a.tone === "warning") ? "warning" : "info";
  return (
    <Callout tone={TONE[worst]} title="Part approval (PPAP)" className={className}>
      <ul aria-label="Part approval" className="flex flex-col gap-1">
        {items.map((a) => (
          <li key={`${a.code}:${a.customerId}`}>
            {a.message}
            {a.submissionId ? (
              <>
                {" "}
                <Link to={ppapPath(a.submissionId)} className="font-medium text-link-color hover:underline">Open</Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </Callout>
  );
};

const Pill = ({ state }) => (state === "none" ? <span className="text-secondary-text">No PPAP</span> : <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${supplierPpapPill(state)}`}>{supplierPpapLabel(state)}</span>);

/** On the part page: each customer of the part, whether they require PPAP, and where the released revision stands for them. Quiet when nobody requires one. */
export const PartPpapCard = ({ partId }) => {
  const { can } = usePermissions();
  const query = usePartPpapState(partId, undefined, { enabled: can("ppap.read") });
  const raise = useRaisePpap();
  if (!can("ppap.read") || !query.data?.available) return null;
  const { customers, revision, canRaise, attention } = query.data;
  if (!customers.some((c) => c.requires || c.state !== "none")) return null;
  return (
    <section aria-label="Part approval" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4">
      <h2 className="text-base font-semibold text-primary-text">Part approval (PPAP){revision ? <span className="font-normal text-secondary-text"> · revision {revision.label}</span> : null}</h2>
      {!revision ? (
        <p className="text-sm text-secondary-text">There is no released revision, so there is nothing to approve yet.</p>
      ) : (
        <table className="w-full text-left text-sm" aria-label="PPAP by customer">
          <thead><tr className="text-secondary-text"><th className="py-1 pr-3 font-medium">Customer</th><th className="py-1 pr-3 font-medium">State</th><th className="py-1 pr-3 font-medium">Package</th><th className="py-1 font-medium" /></tr></thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="border-t border-border-color">
                <td className="py-1.5 pr-3 text-primary-text">{c.name}{c.requires ? "" : <span className="block text-xs text-secondary-text">Not asked for PPAP</span>}</td>
                <td className="py-1.5 pr-3"><Pill state={c.state} />{c.interimExpiresOn ? <span className="block text-xs text-secondary-text">Runs to {formatDate(c.interimExpiresOn)}</span> : c.nextReviewOn ? <span className="block text-xs text-secondary-text">Review {formatDate(c.nextReviewOn)}</span> : null}</td>
                <td className="py-1.5 pr-3">{c.submissionId ? <Link to={ppapPath(c.submissionId)} className="text-link-color hover:underline">{c.reference}</Link> : <span className="text-secondary-text">—</span>}</td>
                <td className="py-1.5 text-right">
                  {canRaise && c.state === "none" && (
                    <CTAButton type="secondary" size="default" loading={raise.pending} onClick={() => raise.start("part_revision", revision.id, { customer: { id: c.id, name: c.name } })}>Start a PPAP</CTAButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {attention.some((a) => a.code === "idle") && <p className="text-xs text-secondary-text">An approved part that has not been made for a year may need a new submission. This is a suggestion, not a requirement.</p>}
      {raise.node}
    </section>
  );
};

/** On a change or a control plan revision: the PPAPs raised from it, and the ones it may call for. A suggestion, never an instruction; nothing is started until a person does. */
export const PpapPrompts = ({ kind, id }) => {
  const { can } = usePermissions();
  const query = usePpapPrompts(kind, id, { enabled: can("ppap.read") });
  const raise = useRaisePpap();
  if (!can("ppap.read") || !query.data?.available) return null;
  const { prompts, raised, canRaise } = query.data;
  if (prompts.length === 0 && raised.length === 0) return null;
  return (
    <section aria-label="PPAP" className="flex flex-col gap-3 rounded-2xl border border-border-color bg-secondary-bg p-4">
      <h2 className="text-base font-semibold text-primary-text">{prompts.length > 0 ? "PPAP likely needed" : "PPAP raised from this"}</h2>
      {prompts.length > 0 && (
        <ul aria-label="PPAP suggestions" className="flex flex-col gap-2">
          {prompts.map((p) => (
            <li key={`${p.partId}:${p.customerId}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-color bg-primary-bg p-3 text-sm">
              <span className="min-w-0 text-primary-text">{p.message}</span>
              {canRaise && (
                <CTAButton type="secondary" size="default" loading={raise.pending} onClick={() => raise.start(kind, id, { part: { id: p.partId, name: p.partNumber }, customer: { id: p.customerId, name: p.customerName } })}>
                  Start a PPAP
                </CTAButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {raised.length > 0 && (
        <ul aria-label="PPAPs raised from this" className="flex flex-col gap-1 text-sm">
          {raised.map((r) => (
            <li key={r.id}>
              <Link to={ppapPath(r.id)} className="font-medium text-link-color hover:underline">{r.reference}</Link>
              <span className="text-secondary-text"> · {r.part.partNumber}{r.customer ? ` to ${r.customer.name}` : ""} · {statusLabel(r.status)}</span>
            </li>
          ))}
        </ul>
      )}
      {raise.node}
    </section>
  );
};
