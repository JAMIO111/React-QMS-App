import { CalendarClockIcon, CalendarIcon, CircleCheckIcon, FactoryIcon, GaugeIcon, HashIcon, HouseIcon, RefreshCwIcon, TagIcon, UsersIcon } from "@/components/icons";
import { formatDate } from "../../lib/ncr";
import { describeDue, formatInterval, formatNumber } from "../../lib/calibration";
import { DuePill, GaugeStatusPill, OutcomePill } from "./Pills";

/**
 * Gauge register columns. `meta.sortKey` is the API sort field; columns without one cannot be
 * sorted (the register is sorted and paged on the server).
 */
const head = (Icon, label, cls = "table-header") => (
  <div className={cls}>
    {Icon && <Icon className="shrink-0" />} {label}
  </div>
);
const text = (info) => <div className="table-row-item">{info.getValue() || "—"}</div>;
const nameOf = (info) => <div className="table-row-item">{info.getValue()?.name ?? "—"}</div>;

const col = (id, headerString, header, cell, { size = 140, minSize = 70, maxSize = 400, sortKey, align, accessor } = {}) => ({
  id,
  headerString,
  header,
  cell,
  ...(accessor ? { accessorFn: accessor } : { accessorKey: id }),
  size,
  minSize,
  maxSize,
  enableSorting: !!sortKey,
  meta: { sortKey, ...(align ? { align } : {}) },
});

export const gaugeColumns = [
  col("assetNumber", "Asset no.", head(HashIcon, "Asset no."), (i) => <div className="table-row-item font-medium">{i.getValue()}</div>, { size: 120, sortKey: "assetNumber" }),
  col("description", "Description", head(GaugeIcon, "Description"), text, { size: 230, minSize: 120, maxSize: 600, sortKey: "description" }),
  col("type", "Type", head(TagIcon, "Type"), nameOf, { size: 170, sortKey: "type" }),
  col("status", "Status", head(CircleCheckIcon, "Status", "table-header-number"), (i) => <GaugeStatusPill status={i.getValue()} />, { size: 130, sortKey: "status", align: "center" }),
  col(
    "nextDueOn",
    "Next due",
    head(CalendarClockIcon, "Next due"),
    (i) => (
      <div className="table-row-item">
        <span className="inline-flex items-center gap-2">
          <span>{formatDate(i.getValue())}</span>
          {["overdue", "due_soon"].includes(i.row.original.dueState) && <DuePill state={i.row.original.dueState} days={i.row.original.daysUntilDue} />}
        </span>
      </div>
    ),
    { size: 190, sortKey: "nextDueOn" }
  ),
  col("dueState", "Due status", head(CalendarClockIcon, "Due status", "table-header-number"), (i) => <DuePill state={i.getValue()} days={i.row.original.daysUntilDue} />, {
    size: 120,
    align: "center",
  }),
  col("daysUntilDue", "Days to due", head(CalendarClockIcon, "Days to due", "table-header-number"), (i) => (
    <div className="table-row-item" title={describeDue(i.getValue())}>{i.getValue() ?? "—"}</div>
  ), { size: 110, sortKey: "nextDueOn", align: "center" }),
  col("lastCalibratedOn", "Last calibrated", head(CalendarIcon, "Last calibrated"), (i) => <div className="table-row-item">{formatDate(i.getValue())}</div>, { size: 140, sortKey: "lastCalibratedOn" }),
  col("lastOutcome", "Last result", head(CircleCheckIcon, "Last result", "table-header-number"), (i) => <OutcomePill outcome={i.getValue()} />, { size: 110, sortKey: "lastOutcome", align: "center" }),
  col("interval", "Interval", head(RefreshCwIcon, "Interval"), (i) => <div className="table-row-item">{formatInterval(i.row.original.intervalValue, i.row.original.intervalUnit)}</div>, {
    size: 110,
    sortKey: "interval",
    accessor: (r) => r.intervalValue,
  }),
  col("site", "Site", head(HouseIcon, "Site"), (i) => <div className="table-row-item">{i.getValue() ? i.getValue().name : "—"}</div>, { size: 140, sortKey: "site" }),
  col("location", "Location", head(HouseIcon, "Location"), text, { size: 150, sortKey: "location" }),
  col("custodian", "Custodian", head(UsersIcon, "Custodian"), nameOf, { size: 150 }),
  col("manufacturer", "Manufacturer", head(FactoryIcon, "Manufacturer"), text, { size: 150, sortKey: "manufacturer" }),
  col("model", "Model", head(FactoryIcon, "Model"), text, { size: 130 }),
  col("serialNumber", "Serial no.", head(HashIcon, "Serial no."), text, { size: 140, sortKey: "serialNumber" }),
  col(
    "range",
    "Range",
    head(GaugeIcon, "Range"),
    (i) => {
      const g = i.row.original;
      return <div className="table-row-item">{g.rangeMin !== null || g.rangeMax !== null ? `${formatNumber(g.rangeMin)} – ${formatNumber(g.rangeMax)} ${g.unitCode ?? ""}` : "—"}</div>;
    },
    { size: 140, accessor: (r) => r.rangeMax }
  ),
  col("calibrationSource", "Calibrated", head(FactoryIcon, "Calibrated"), (i) => <div className="table-row-item">{i.getValue() === "external" ? "External" : "In-house"}</div>, { size: 110 }),
  col("supplier", "Calibration supplier", head(UsersIcon, "Calibration supplier"), nameOf, { size: 170 }),
  col("calibrationCount", "Calibrations", head(HashIcon, "Calibrations", "table-header-number"), (i) => <div className="table-row-item">{i.getValue()}</div>, { size: 110, align: "center" }),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = { dueState: false, daysUntilDue: false, model: false, range: false, calibrationSource: false, supplier: false, calibrationCount: false, custodian: false };
