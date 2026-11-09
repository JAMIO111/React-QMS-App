import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import { useMaterialCertificates } from "../../hooks/useMaterialCertificates";
import { usePermissions } from "../../hooks/useQmsApi";
import { formatDate } from "../../lib/ncr";
import { tracePath } from "../../lib/production";
import { CERT_FILTERS, CERT_STATUS, certKindLabel } from "../../lib/materialCertificates";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import { CertificateDecisionDialog, RecordCertificateDialog } from "./CertificateDialogs";

const PAGE_SIZE = 25;

export const CertStatusPill = ({ status }) => {
  const s = CERT_STATUS[status] ?? CERT_STATUS.received;
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>;
};

/** Material certificates: what suppliers sent with material, traced to receipt lines, lots and heat numbers; the ones waiting for review come first. */
const MaterialCertificatesPage = () => {
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const status = CERT_FILTERS.some((f) => f.value === params.get("status")) ? params.get("status") : "live";
  const q = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [dialog, setDialog] = useState(null); // { kind: "record" | "edit" | "review" | "withdraw", certificate? }
  const query = useMaterialCertificates({ status, q: q || undefined, page, pageSize: PAGE_SIZE });
  const set = useCallback((changes) => setParams((p) => { const n = new URLSearchParams(p); Object.entries(changes).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k))); return n; }), [setParams]);
  const onSearch = useCallback((v) => set({ q: v, page: "" }), [set]);
  const rows = query.data?.data ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const record = can("receiving.manage");
  const review = can("supplier_quality.manage");
  const close = () => setDialog(null);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Material certificates</h1>
          <p className="text-sm text-secondary-text">Mill test reports and certificates of conformance or analysis, traced to the receipt, the lot and the heat number. A quality manager accepts or rejects each one.</p>
        </div>
        {record && <CTAButton type="main" size="default" icon={PlusIcon} onClick={() => setDialog({ kind: "record" })}>Record a certificate</CTAButton>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SlidingToggle ariaLabel="Which certificates" options={CERT_FILTERS.map((f) => (f.value === "review" && query.data?.reviewCount ? { ...f, count: query.data.reviewCount } : f))} value={status} onChange={(v) => set({ status: v === "live" ? "" : v, page: "" })} />
        <SearchBox label="Search certificates" onSearch={onSearch} />
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading ? <p className="text-sm text-secondary-text">Loading…</p> : rows.length === 0 ? (
        <Callout tone="info" title="No certificates here">{q ? "No certificate matches that search." : status === "review" ? "Nothing is waiting for review." : "Nothing matches this view."}</Callout>
      ) : (
        <MenuCard title={`${total} ${total === 1 ? "certificate" : "certificates"}`} subtitle="Waiting for review first, then newest.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Material certificates">
              <thead>
                <tr className="text-left text-xs text-secondary-text">
                  <th className="py-1 pr-3 font-medium">Certificate</th>
                  <th className="py-1 pr-3 font-medium">Supplier</th>
                  <th className="py-1 pr-3 font-medium">Covers</th>
                  <th className="py-1 pr-3 font-medium">Traced to</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t border-border-color align-top">
                    <td className="py-2 pr-3 text-primary-text"><span className="font-medium">{c.certificateNumber}</span><span className="block text-xs text-secondary-text">{certKindLabel(c.kind)}{c.issuedOn ? ` · issued ${formatDate(c.issuedOn)}` : ""}{c.specification ? ` · ${c.specification}` : ""}</span></td>
                    <td className="whitespace-nowrap py-2 pr-3"><Link to={`/Suppliers/${c.supplier.id}`} className="text-secondary-text hover:underline">{c.supplier.code} · {c.supplier.name}</Link></td>
                    <td className="py-2 pr-3 text-primary-text">{c.part ? `${c.part.partNumber} · ${c.part.name}` : c.material}</td>
                    <td className="py-2 pr-3 text-secondary-text">
                      {c.heatNumber && <span className="block">Heat {c.heatNumber}</span>}
                      {c.lot && <Link to={tracePath("lot", c.lot.id)} className="block text-link-color hover:underline">Lot {c.lot.lotNumber}</Link>}
                      {c.receiptLine && <Link to={`/Supplier-Quality/Goods-Receipts/${c.receiptLine.receiptId}`} className="block text-link-color hover:underline">{c.receiptLine.receiptReference} line {c.receiptLine.lineNumber}</Link>}
                    </td>
                    <td className="py-2 pr-3"><CertStatusPill status={c.status} />{(c.reviewNote || c.withdrawalReason) && <span className="mt-1 block text-xs text-secondary-text">{c.withdrawalReason ?? c.reviewNote}</span>}</td>
                    <td className="py-2 text-right">
                      <span className="flex flex-wrap justify-end gap-3 text-xs">
                        {c.status === "received" && review && <button type="button" className="text-link-color hover:underline" aria-label={`Review ${c.certificateNumber}`} onClick={() => setDialog({ kind: "review", certificate: c })}>Review</button>}
                        {c.status === "received" && record && <button type="button" className="text-link-color hover:underline" aria-label={`Edit ${c.certificateNumber}`} onClick={() => setDialog({ kind: "edit", certificate: c })}>Edit</button>}
                        {c.status !== "withdrawn" && record && <button type="button" className="text-secondary-text hover:underline" aria-label={`Withdraw ${c.certificateNumber}`} onClick={() => setDialog({ kind: "withdraw", certificate: c })}>Withdraw</button>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-3 text-sm text-secondary-text">
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page <= 1} onClick={() => set({ page: page <= 2 ? "" : String(page - 1) })}>Previous</button>
              <span>Page {page} of {pages}</span>
              <button type="button" className="hover:underline disabled:opacity-40" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
            </div>
          )}
        </MenuCard>
      )}
      {dialog?.kind === "record" && <RecordCertificateDialog onClose={close} />}
      {dialog?.kind === "edit" && <RecordCertificateDialog certificate={dialog.certificate} onClose={close} />}
      {(dialog?.kind === "review" || dialog?.kind === "withdraw") && <CertificateDecisionDialog certificate={dialog.certificate} mode={dialog.kind} onClose={close} />}
    </div>
  );
};

export default MaterialCertificatesPage;
