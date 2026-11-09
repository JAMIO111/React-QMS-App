import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useScars } from "../../hooks/useSupplierQuality";
import { scarIsRunning } from "../../lib/supplierScars";
import CTAButton from "../CTAButton";
import { CreateScarDialog } from "./ScarDialogs";
import ScarsList from "./ScarsList";

/**
 * On the NC page: the supplier corrective action requests this non-conformance is part of, and a way to raise one from it (the supplier and this NC are
 * preselected). Shown only when the NC names a supplier and the person may read supplier quality.
 */
const NcrScarCard = ({ ncr }) => {
  const { can } = usePermissions();
  const [creating, setCreating] = useState(false);
  const allowed = !!ncr.supplier && can("supplier_quality.read");
  const query = useScars({ ncrId: ncr.id, status: "all", pageSize: 20 }, { enabled: allowed });
  if (!allowed) return null;
  const rows = query.data?.data ?? [];
  const live = rows.filter((r) => scarIsRunning(r.status));
  return (
    <section aria-label="Supplier corrective action" className="mt-4 flex flex-col gap-2 rounded-lg border border-border-color p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-primary-text">Supplier corrective action</h3>
          <p className="text-xs text-secondary-text">Ask {ncr.supplier.name} to investigate and fix this. Their response is reviewed and checked here.</p>
        </div>
        {can("supplier_quality.manage") && (
          <CTAButton type="secondary" size="default" icon={PlusIcon} onClick={() => setCreating(true)}>{live.length ? "Raise another SCAR" : "Raise a SCAR"}</CTAButton>
        )}
      </div>
      {rows.length === 0 ? <p className="text-sm text-secondary-text">{query.isLoading ? "Loading…" : "No SCAR raised for this non-conformance."}</p> : <ScarsList rows={rows} showSupplier={false} ariaLabel="SCARs for this non-conformance" />}
      {creating && <CreateScarDialog supplier={{ id: ncr.supplier.id, name: ncr.supplier.name }} ncrId={ncr.id} onClose={() => setCreating(false)} />}
    </section>
  );
};

export default NcrScarCard;
