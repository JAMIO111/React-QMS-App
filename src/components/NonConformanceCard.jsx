import CTAButton from "./CTAButton";
import RowActionsMenu from "./ui/RowActionsMenu";
import { CalendarIcon, EllipsisVerticalIcon, LayersIcon, QrCodeIcon } from "@/components/icons";
import { formatDate, sourceLabel } from "../lib/ncr";
import { SeverityPill, StagePill } from "./ncr/Pills";

/** One NCR as a card (grid view). Click the reference to open it; Actions opens the row menu. */
const NonConformanceCard = ({ item, selected, setSelectedItem, rowActions, onOpen }) => {
  const party = item.customer?.name ?? item.supplier?.name;
  const partyRef = item.customerReference ?? item.purchaseOrder;

  return (
    <article
      onClick={() => setSelectedItem(item)}
      className={`${selected ? "border-brand-primary" : "border-border-color"} ${item.deletedAt ? "opacity-60" : ""} border flex flex-col justify-between rounded-xl bg-secondary-bg`}>
      <div className="flex flex-row justify-between gap-3 border-b border-border-color p-3">
        <div className="flex min-w-0 flex-col gap-1">
          <button type="button" onClick={() => onOpen(item)} className="w-fit font-semibold text-link-color hover:underline cursor-pointer">
            {item.reference}
          </button>
          <span className="truncate text-secondary-text" title={item.title}>
            {item.title}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {party && <span className="text-primary-text font-semibold text-right">{party}</span>}
          {partyRef && <span className="text-secondary-text text-sm text-right">{partyRef}</span>}
          <div className="flex flex-row items-center gap-2">
            <CalendarIcon className="text-primary-text h-4 w-4" />
            <span className="text-secondary-text">{formatDate(item.detectedAt)}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-4 p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-primary-text">
          <span className="rounded-full border border-border-color px-2 py-0.5">{sourceLabel(item.source)}</span>
          <span className="rounded-full border border-border-color px-2 py-0.5">{item.category?.name ?? "Uncategorised"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-secondary-text">
          {[item.failureMode?.name, item.subFailureMode?.name, item.causalProcess?.name].filter(Boolean).join(" · ") || "Not classified"}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {item.workOrder && <span className="whitespace-nowrap text-primary-text py-1.5 px-3 rounded-lg border border-border-color">{item.workOrder}</span>}
          {item.part && (
            <span className="flex items-center gap-2 whitespace-nowrap text-primary-text py-1.5 px-3 rounded-lg border border-border-color">
              <QrCodeIcon className="h-4 w-4" />
              {item.part.partNumber}
              {item.part.revision ? ` · ${item.part.revision}` : ""}
            </span>
          )}
          {item.quantityAffected != null && (
            <span className="flex items-center gap-2 whitespace-nowrap text-primary-text py-1.5 px-3 rounded-lg border border-border-color">
              <LayersIcon className="h-4 w-4" />× {item.quantityAffected}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-row justify-between items-center border-t border-border-color p-3">
        <div className="flex items-center gap-2">
          <StagePill stage={item.stage} />
          <SeverityPill severity={item.severity} />
          {item.deletedAt && <span className="rounded-full bg-error-color/15 px-2 py-0.5 text-xs text-error-color">Deleted</span>}
        </div>
        <RowActionsMenu
          items={rowActions?.(item)}
          label={`Actions for ${item.reference}`}
          trigger={(props) => <CTAButton {...props} text="Actions" type="main" icon={EllipsisVerticalIcon} aria-label="Actions" />}
        />
      </div>
    </article>
  );
};

export default NonConformanceCard;
