import { useState } from "react";
import { Link } from "react-router-dom";
import { useSupplierPpap } from "../../hooks/useSupplierQuality";
import { usePermissions } from "../../hooks/useQmsApi";
import { ppapPath, supplierPpapLabel, supplierPpapPill } from "../../lib/ppap";
import { formatDate } from "../../lib/ncr";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import { ErrorNotice } from "../master-data/shared";
import { NewPpapDialog } from "../ppap/PpapDialogs";

const Pill = ({ state }) => <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${supplierPpapPill(state)}`}>{supplierPpapLabel(state)}</span>;

/**
 * The supplier's Part approvals tab: for each part we buy from them that has a part approval package (PPAP) on record, where it stands. INFORMATION ONLY: nothing here changes the
 * supplier's approval status or an inspection requirement; an unapproved part is one reason the inspection recommendation on the Incoming quality tab gives.
 */
export default function SupplierPpap({ supplier }) {
  const { can } = usePermissions();
  const [recording, setRecording] = useState(false);
  const query = useSupplierPpap(supplier.id);
  const r = query.data;
  const rows = r?.data ?? [];
  const lapsed = rows.filter((x) => x.state === "interim_lapsed");

  return (
    <div className="flex flex-col gap-4">
      <MenuCard
        title="Part approvals"
        subtitle="Where each part's part approval package from this supplier stands. The newest package of a part decides. For information: this never changes the supplier's approval status."
        action={can("ppap.manage") && <CTAButton type="main" size="default" onClick={() => setRecording(true)}>Record a package</CTAButton>}>
        {query.error && <ErrorNotice error={query.error} />}
        {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : r && !r.available ? (
          <p className="text-sm text-secondary-text">You do not have access to part approvals.</p>
        ) : r ? (
          <div className="flex flex-col gap-3">
            {lapsed.length > 0 && (
              <Callout tone="warning" title="An interim approval has run out">
                {lapsed.map((x) => x.partNumber).join(", ")}: the interim approval ended and no decision has been recorded since. Record a decision, or ask the supplier for a full package.
              </Callout>
            )}
            {rows.length === 0 ? (
              <p className="text-sm text-secondary-text">No part approval package has been recorded for this supplier.</p>
            ) : (
              <>
                <p className="text-sm text-primary-text" aria-live="polite">
                  <strong className="tabular-nums">{r.counts.approved}</strong> approved · <strong className="tabular-nums">{r.counts.interim}</strong> on an interim approval · <strong className="tabular-nums">{r.counts.notApproved}</strong> not approved
                </p>
                <table className="w-full text-left text-sm" aria-label="Part approvals of this supplier">
                  <thead><tr className="text-secondary-text"><th className="py-1 pr-3 font-medium">Part</th><th className="py-1 pr-3 font-medium">State</th><th className="py-1 pr-3 font-medium">Package</th><th className="py-1 font-medium">Dates</th></tr></thead>
                  <tbody>
                    {rows.map((x) => (
                      <tr key={x.partId} className="border-t border-border-color">
                        <td className="py-1.5 pr-3 text-primary-text">{x.partNumber}{x.revision ? <span className="text-secondary-text"> rev {x.revision}</span> : null}<span className="block text-xs text-secondary-text">{x.partName}</span></td>
                        <td className="py-1.5 pr-3"><Pill state={x.state} /></td>
                        <td className="py-1.5 pr-3"><Link to={ppapPath(x.submissionId)} className="text-link-color hover:underline">{x.reference}</Link></td>
                        <td className="py-1.5 text-primary-text">
                          {x.interimExpiresOn ? `Runs to ${formatDate(x.interimExpiresOn)}` : x.nextReviewOn ? `Review ${formatDate(x.nextReviewOn)}` : <span className="text-secondary-text">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <p className="text-xs text-secondary-text">Every package, including earlier ones, is in the <Link to="/PPAP" className="text-link-color hover:underline">PPAP register</Link>.</p>
          </div>
        ) : null}
      </MenuCard>
      {recording && <NewPpapDialog onClose={() => setRecording(false)} defaults={{ direction: "received", supplier: { id: supplier.id, name: supplier.displayName || supplier.name } }} />}
    </div>
  );
}
