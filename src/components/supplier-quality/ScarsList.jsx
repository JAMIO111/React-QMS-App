import { Link } from "react-router-dom";
import { formatDate } from "../../lib/ncr";
import { scarPath } from "../../lib/supplierScars";
import { OverdueFlag, ScarSeverityPill, ScarStatusPill } from "./ScarPills";

/** The SCAR table used by the register, the supplier's profile and the NC page. `showSupplier` adds the supplier column. */
const ScarsList = ({ rows, showSupplier = true, ariaLabel = "SCARs" }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm" aria-label={ariaLabel}>
      <thead>
        <tr className="text-left text-xs text-secondary-text">
          <th className="py-1 pr-3 font-medium">Reference</th>
          <th className="py-1 pr-3 font-medium">Title</th>
          {showSupplier && <th className="py-1 pr-3 font-medium">Supplier</th>}
          <th className="py-1 pr-3 font-medium">Owner</th>
          <th className="py-1 pr-3 font-medium">Severity</th>
          <th className="py-1 pr-3 font-medium">Status</th>
          <th className="py-1 pr-3 font-medium">Response due</th>
          <th className="py-1 font-medium">NCs</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-t border-border-color align-top">
            <td className="whitespace-nowrap py-2 pr-3">
              <Link to={scarPath(r.id)} className="text-link-color hover:underline">{r.reference}</Link>
            </td>
            <td className="py-2 pr-3 text-primary-text">{r.title}</td>
            {showSupplier && (
              <td className="whitespace-nowrap py-2 pr-3">
                <Link to={`/Suppliers/${r.supplier.id}`} className="text-secondary-text hover:underline">{r.supplier.code} · {r.supplier.name}</Link>
              </td>
            )}
            <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{r.owner?.name ?? "—"}</td>
            <td className="py-2 pr-3"><ScarSeverityPill severity={r.severity} /></td>
            <td className="py-2 pr-3"><ScarStatusPill status={r.status} /></td>
            <td className="whitespace-nowrap py-2 pr-3 text-secondary-text">{r.responseDueOn ? formatDate(r.responseDueOn) : "—"}<OverdueFlag scar={r} /></td>
            <td className="py-2 tabular-nums text-secondary-text">{r.ncrCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default ScarsList;
