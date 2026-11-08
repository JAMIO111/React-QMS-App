import { Link } from "react-router-dom";
import { RouteIcon } from "@/components/icons";
import { tracePath } from "../../lib/production";

/** Links to the traceability page for the order, lot and serial number a job, inspection or non-conformance is linked to. Nothing when it is linked to none. */
const TraceLinks = ({ links }) => {
  const items = [
    links?.productionOrder && { key: "order", id: links.productionOrder.id, label: `order ${links.productionOrder.orderNumber}` },
    links?.lot && { key: "lot", id: links.lot.id, label: `lot ${links.lot.lotNumber}` },
    links?.serial && { key: "serial", id: links.serial.id, label: `serial ${links.serial.serialNumber}` },
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <p aria-label="Trace" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-secondary-text">
      <RouteIcon className="shrink-0" aria-hidden="true" /> Trace
      {items.map((i) => (
        <Link key={i.key} to={tracePath(i.key, i.id)} className="text-link-color hover:underline">
          {i.label}
        </Link>
      ))}
    </p>
  );
};

export default TraceLinks;
