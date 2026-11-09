import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PencilIcon, PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useSupplier, useSupplierHistory, useSupplierMutation } from "../../hooks/useSupplierQuality";
import { addressLine, contactRoleLabel, productKindLabel, typeLabel } from "../../lib/supplierQuality";
import { formatDate } from "../../lib/ncr";
import { formatDateTime } from "../../lib/processControl";
import { countryName } from "../../lib/onboarding";
import Breadcrumb from "../Breadcrumb";
import CTAButton from "../CTAButton";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import SlidingToggle from "../ui/SlidingToggle";
import Switch from "../ui/Switch";
import { ErrorNotice } from "../master-data/shared";
import { ContactDialog, ProductDialog } from "./ContactProductDialogs";
import StatusChangeDialog from "./StatusChangeDialog";
import SupplierDialog from "./SupplierDialog";
import { ActivityBadge, ApprovalPill, RiskBadge } from "./SupplierBadges";
import { CertificationsCard, DocumentsCard } from "./Qualification";
import { RiskCard } from "./RiskAssessment";
import { ApprovalCard, AssessmentsCard } from "./Approvals";
import SupplierNcs from "./SupplierNcs";
import SupplierReceiving from "./SupplierReceiving";
import SupplierScars from "./SupplierScars";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "performance", label: "Performance" },
  { value: "qualification", label: "Qualification" },
  { value: "incoming", label: "Incoming quality" },
  { value: "nonconformities", label: "Nonconformities" },
  { value: "scars", label: "SCARs" },
  { value: "audits", label: "Audits" },
  { value: "documents", label: "Documents" },
  { value: "products", label: "Products & services" },
  { value: "history", label: "History" },
];

const Row = ({ label, children }) =>
  children ? (
    <div className="grid grid-cols-3 gap-2 py-1 text-sm">
      <dt className="text-secondary-text">{label}</dt>
      <dd className="col-span-2 min-w-0 break-words text-primary-text">{children}</dd>
    </div>
  ) : null;

const Tile = ({ label, value, to }) => {
  const body = (
    <div className="rounded-xl border border-border-color bg-secondary-bg p-3">
      <p className="text-2xl font-semibold tabular-nums text-primary-text">{value}</p>
      <p className="text-xs text-secondary-text">{label}</p>
    </div>
  );
  return to ? (
    <Link to={to} className="hover:opacity-80">
      {body}
    </Link>
  ) : (
    body
  );
};

/** A part of the profile that is built in a later release: said plainly, not hidden. */
const NotYet = ({ title, text }) => (
  <MenuCard title={title}>
    <p className="text-sm text-secondary-text">{text}</p>
  </MenuCard>
);

const Overview = ({ supplier, canManage, onEditContact, onAddContact }) => {
  const s = supplier;
  const ncLink = `/Non-Conformance/Register?supplier=${s.id}&supplierLabel=${encodeURIComponent(s.displayName || s.name)}`;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:col-span-2">
        <Tile label="Open non-conformances" value={s.counts.openNcs} to={ncLink} />
        <Tile label="Non-conformances in all" value={s.counts.totalNcs} to={ncLink} />
        <Tile label="Lots received" value={s.counts.receivedLots} />
        <Tile label="Last received" value={s.counts.lastReceivedOn ? formatDate(s.counts.lastReceivedOn) : "—"} />
      </div>
      <MenuCard title="Approval">
        <dl>
          <Row label="Status">
            <ApprovalPill status={s.approvalStatus} />
          </Row>
          <Row label="Activity">
            <ActivityBadge active={s.active} />
          </Row>
          <Row label="Risk rating">
            <RiskBadge risk={s.riskRating} />
          </Row>
          <Row label="Changed">{s.approvalStatusChangedAt ? `${formatDateTime(s.approvalStatusChangedAt)}${s.approvalStatusChangedBy ? ` by ${s.approvalStatusChangedBy.name}` : ""}` : null}</Row>
          <Row label="Conditions">{s.conditions}</Row>
          <Row label="Review on">{s.reviewOn ? formatDate(s.reviewOn) : null}</Row>
        </dl>
        {s.approvalStatus === "pending_approval" && <p className="mt-2 text-xs text-secondary-text">Not approved yet: a supplier is never treated as approved until someone with the right decides.</p>}
      </MenuCard>
      <MenuCard title="Details">
        <dl>
          <Row label="Legal name">{s.name}</Row>
          <Row label="Trading name">{s.displayName}</Row>
          <Row label="Type">{typeLabel(s.supplierType)}</Row>
          <Row label="Classifications">
            {s.classifications.length ? (
              <span className="flex flex-wrap gap-1">
                {s.classifications.map((c) => (
                  <span key={c.id} className="rounded-full border border-border-color bg-secondary-bg px-2 py-0.5 text-xs text-secondary-text">
                    {c.label}
                  </span>
                ))}
              </span>
            ) : null}
          </Row>
          <Row label="Address">{addressLine({ ...s, country: s.country ? countryName(s.country) : null })}</Row>
          <Row label="Website">{s.website}</Row>
          <Row label="Email">{s.email}</Row>
          <Row label="Phone">{s.phone}</Row>
          <Row label="Purchasing ref.">{s.purchasingReference}</Row>
          <Row label="Company number">{s.companyNumber}</Row>
          <Row label="VAT number">{s.vatNumber}</Row>
          <Row label="Notes">{s.notes}</Row>
        </dl>
      </MenuCard>
      <MenuCard
        title="Contacts"
        action={canManage && (
          <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} iconSize="h-4 w-4" onClick={onAddContact}>
            Add contact
          </CTAButton>
        )}>
        {s.contacts.length === 0 ? (
          <p className="text-sm text-secondary-text">No contacts yet.</p>
        ) : (
          <ul aria-label="Contacts" className="flex flex-col divide-y divide-border-color">
            {s.contacts.map((c) => (
              <li key={c.id} className={`flex items-start gap-3 py-2 ${c.active ? "" : "opacity-60"}`}>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium text-primary-text">
                    {c.name}
                    {c.isPrimary && <span className="ml-2 rounded-full bg-brand-primary/15 px-2 py-0.5 text-xs text-brand-primary">Primary</span>}
                    {!c.active && <span className="ml-2 text-xs text-secondary-text">(inactive)</span>}
                  </p>
                  <p className="text-xs text-secondary-text">{[c.jobTitle, contactRoleLabel(c.role)].filter(Boolean).join(" · ")}</p>
                  <p className="text-xs text-secondary-text">{[c.email, c.phone].filter(Boolean).join(" · ")}</p>
                </div>
                {canManage && (
                  <button type="button" aria-label={`Edit ${c.name}`} onClick={() => onEditContact(c)} className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer">
                    <PencilIcon />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </MenuCard>
    </div>
  );
};

const Products = ({ supplier, canManage, onAdd }) => {
  const mutation = useSupplierMutation();
  return (
    <MenuCard
      title="Products and services"
      subtitle="Parts of ours this supplier supplies, and materials and services in words."
      action={canManage && (
        <CTAButton buttonType="button" type="secondary" size="default" icon={PlusIcon} iconSize="h-4 w-4" onClick={onAdd}>
          Add
        </CTAButton>
      )}>
      {supplier.products.length === 0 ? (
        <p className="text-sm text-secondary-text">Nothing linked yet.</p>
      ) : (
        <ul aria-label="Products and services" className="flex flex-col divide-y divide-border-color">
          {supplier.products.map((p) => (
            <li key={p.id} className={`flex items-center gap-3 py-2 text-sm ${p.active ? "" : "opacity-60"}`}>
              <span className="w-20 shrink-0 text-xs text-secondary-text">{productKindLabel(p.kind)}</span>
              <div className="min-w-0 flex-1">
                {p.part ? (
                  <Link to={`/Parts/${p.part.id}`} className="font-medium text-link-color hover:underline">
                    {p.part.partNumber} <span className="font-normal text-secondary-text">{p.part.name}</span>
                  </Link>
                ) : (
                  <span className="font-medium text-primary-text">{p.description}</span>
                )}
                {p.supplierPartNumber && <p className="text-xs text-secondary-text">Their number: {p.supplierPartNumber}</p>}
                {p.notes && <p className="text-xs text-secondary-text">{p.notes}</p>}
              </div>
              {canManage && (
                <Switch checked={p.active} onChange={(e) => mutation.mutate({ action: "updateProduct", id: p.id, body: { active: e.target.checked } })} aria-label={`${p.part?.partNumber ?? p.description} is current`} />
              )}
            </li>
          ))}
        </ul>
      )}
    </MenuCard>
  );
};

const History = ({ id }) => {
  const history = useSupplierHistory(id);
  const items = history.data?.data ?? [];
  return (
    <MenuCard title="Approval history" subtitle="Every change of approval status, newest first. Nothing is overwritten.">
      {history.isLoading && <p className="text-sm text-secondary-text">Loading…</p>}
      {history.error && <ErrorNotice error={history.error} />}
      <ol aria-label="Approval history" className="flex flex-col divide-y divide-border-color">
        {items.map((h) => (
          <li key={h.id} className="py-2 text-sm">
            <p className="flex flex-wrap items-center gap-2 text-primary-text">
              {h.fromStatus ? (
                <>
                  <ApprovalPill status={h.fromStatus} /> <span aria-hidden="true">→</span>
                </>
              ) : (
                <span className="text-secondary-text">Recorded as</span>
              )}
              <ApprovalPill status={h.toStatus} />
              <span className="text-xs text-secondary-text">
                {formatDateTime(h.changedAt)}
                {h.changedBy ? ` · ${h.changedBy.name}` : ""}
              </span>
            </p>
            {h.reason && <p className="mt-1 text-secondary-text">{h.reason}</p>}
            {h.conditions && <p className="mt-1 text-secondary-text">Conditions: {h.conditions}</p>}
            {h.reviewOn && <p className="mt-1 text-xs text-secondary-text">Review on {formatDate(h.reviewOn)}</p>}
          </li>
        ))}
      </ol>
    </MenuCard>
  );
};

/** A supplier's workspace (/Suppliers/:id): overview, products and services and approval history are live; the other tabs say what is still to come. */
const SupplierProfilePage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can } = usePermissions();
  const supplier = useSupplier(id);
  const [dialog, setDialog] = useState(null); // { kind: "edit" | "status" | "contact" | "product", ... }
  const tab = TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "overview";
  const canManage = can("supplier_quality.manage");
  const canApprove = can("supplier_quality.approve");

  if (supplier.isLoading) return <LoadingScreen />;
  if (supplier.error)
    return (
      <div className="p-4">
        <ErrorNotice error={supplier.error} />
        <CTAButton buttonType="button" type="neutral" size="md" className="mt-3" onClick={() => navigate("/Suppliers")}>
          Back to suppliers
        </CTAButton>
      </div>
    );
  const s = supplier.data;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Breadcrumb />
          <h1 className="text-2xl font-semibold text-primary-text">
            {s.code} · {s.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <ApprovalPill status={s.approvalStatus} />
            <ActivityBadge active={s.active} />
            {s.riskRating && <RiskBadge risk={s.riskRating} />}
            {s.approvalStatus === "conditional" && s.reviewOn && <span className="text-xs text-secondary-text">Review on {formatDate(s.reviewOn)}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <CTAButton buttonType="button" type="secondary" size="default" icon={PencilIcon} iconSize="h-4 w-4" onClick={() => setDialog({ kind: "edit" })}>
              Edit supplier
            </CTAButton>
          )}
          {canApprove && (
            <CTAButton buttonType="button" type="main" size="default" onClick={() => setDialog({ kind: "status" })}>
              Change approval status
            </CTAButton>
          )}
        </div>
      </div>

      <SlidingToggle ariaLabel="Supplier sections" mode="tabs" options={TABS} value={tab} onChange={(v) => setParams((p) => { const n = new URLSearchParams(p); if (v === "overview") n.delete("tab"); else n.set("tab", v); return n; })} />

      {tab === "overview" && <Overview supplier={s} canManage={canManage} onAddContact={() => setDialog({ kind: "contact" })} onEditContact={(c) => setDialog({ kind: "contact", contact: c })} />}
      {tab === "products" && <Products supplier={s} canManage={canManage} onAdd={() => setDialog({ kind: "product" })} />}
      {tab === "history" && <History id={s.id} />}
      {tab === "nonconformities" && <SupplierNcs supplier={s} />}
      {tab === "scars" && <SupplierScars supplier={s} />}
      {tab === "performance" && <NotYet title="Performance" text="Scorecards, PPM and on-time delivery are not available yet." />}
      {tab === "qualification" && (
        <>
          <ApprovalCard supplier={s} canManage={canManage} canApprove={canApprove} />
          <AssessmentsCard supplier={s} canManage={canManage} onOpen={(assessmentId) => navigate(`/Suppliers/${s.id}/assessments/${assessmentId}`)} />
          <RiskCard supplier={s} canManage={canManage} />
          <CertificationsCard supplierId={s.id} canManage={canManage} />
        </>
      )}
      {tab === "incoming" && <SupplierReceiving supplier={s} />}
      {tab === "audits" && <NotYet title="Audits" text="Supplier audits are not available yet." />}
      {tab === "documents" && <DocumentsCard supplierId={s.id} canManage={canManage} />}

      {dialog?.kind === "edit" && <SupplierDialog supplier={s} onClose={() => setDialog(null)} />}
      {dialog?.kind === "status" && <StatusChangeDialog supplier={s} onClose={() => setDialog(null)} />}
      {dialog?.kind === "contact" && <ContactDialog supplierId={s.id} contact={dialog.contact} onClose={() => setDialog(null)} />}
      {dialog?.kind === "product" && <ProductDialog supplierId={s.id} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default SupplierProfilePage;
