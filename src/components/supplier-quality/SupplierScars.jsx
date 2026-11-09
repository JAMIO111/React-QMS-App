import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useScars } from "../../hooks/useSupplierQuality";
import CTAButton from "../CTAButton";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice } from "../master-data/shared";
import { CreateScarDialog } from "./ScarDialogs";
import ScarsList from "./ScarsList";

const VIEWS = [{ value: "running", label: "Running" }, { value: "all", label: "All" }];

/** The supplier's corrective action requests, on its profile. */
const SupplierScars = ({ supplier }) => {
  const { can } = usePermissions();
  const [view, setView] = useState("running");
  const [creating, setCreating] = useState(false);
  const query = useScars({ supplierId: supplier.id, status: view, pageSize: 50, sort: "createdAt", order: "desc" });
  const rows = query.data?.data ?? [];
  return (
    <MenuCard title="Corrective action requests" subtitle="Requests for this supplier to investigate and fix a problem."
      action={
        <div className="flex items-center gap-2">
          <SlidingToggle ariaLabel="Which SCARs" options={VIEWS} value={view} onChange={setView} />
          {can("supplier_quality.manage") && <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setCreating(true)}>Raise a SCAR</CTAButton>}
        </div>
      }>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-secondary-text">{view === "running" ? "No running SCARs for this supplier." : "No SCARs for this supplier."}</p>
      ) : <ScarsList rows={rows} showSupplier={false} />}
      {creating && <CreateScarDialog supplier={supplier} onClose={() => setCreating(false)} />}
    </MenuCard>
  );
};

export default SupplierScars;
