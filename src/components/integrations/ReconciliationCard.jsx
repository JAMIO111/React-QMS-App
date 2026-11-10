import { useState } from "react";
import { useReceiptReconciliation } from "../../hooks/useIntegrations";
import { RECONCILIATION_STATES } from "../../lib/integrations";
import { formatDate } from "../../lib/processControl";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";
import { ErrorNotice } from "../master-data/shared";

const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });

/**
 * The received quantities check (IN6c). For every order line the source reported a "received so far" total for (a received-quantities import, or a
 * purchase order import that carries one), what Fortress has received (receipts not cancelled) against what the source says. Information only: nothing
 * is changed from here. Shown once the connection has reported any totals.
 */
const ReconciliationCard = ({ connectionId }) => {
  const [all, setAll] = useState(false);
  const check = useReceiptReconciliation(connectionId, { all });
  const counts = check.data?.counts;
  const total = counts ? counts.short + counts.over + counts.date + counts.match : 0;
  if (!check.error && (!counts || total === 0)) return null;
  const mismatches = counts ? counts.short + counts.over + counts.date : 0;
  const rows = check.data?.data ?? [];
  return (
    <MenuCard
      title="Received quantities check"
      subtitle={`What Fortress has received on each order line against what the source reports. ${mismatches === 0 ? `All ${total} lines agree.` : `${mismatches} of ${total} lines disagree.`}`}
      action={<Switch checked={all} onChange={(e) => setAll(e.target.checked)}>Show lines that agree</Switch>}>
      {check.error ? (
        <ErrorNotice error={check.error} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-secondary-text">Every order line agrees with the source.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm" aria-label="Received quantities check">
            <thead className="text-xs text-secondary-text">
              <tr>
                <th className="px-2 py-1.5">Order line</th>
                <th className="px-2 py-1.5">Supplier</th>
                <th className="px-2 py-1.5">Item</th>
                <th className="px-2 py-1.5 text-right">Source says</th>
                <th className="px-2 py-1.5 text-right">Fortress has</th>
                <th className="px-2 py-1.5">Last received</th>
                <th className="px-2 py-1.5">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-color">
              {rows.map((r) => {
                const s = RECONCILIATION_STATES[r.state];
                return (
                  <tr key={r.poLineId}>
                    <td className="whitespace-nowrap px-2 py-1.5 text-primary-text">{r.poNumber} / {r.lineNumber}</td>
                    <td className="px-2 py-1.5">{r.supplier}</td>
                    <td className="px-2 py-1.5">{r.item ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.sourceQuantity)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmt(r.fortressQuantity)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-secondary-text">
                      {r.sourceLastReceivedOn ? `Source ${formatDate(r.sourceLastReceivedOn)}` : "Source —"} · {r.fortressLastReceivedOn ? `Fortress ${formatDate(r.fortressLastReceivedOn)}` : "Fortress —"}
                    </td>
                    <td className="px-2 py-1.5"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </MenuCard>
  );
};

export default ReconciliationCard;
