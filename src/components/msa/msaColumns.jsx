import { Link } from "react-router-dom";
import { CalendarIcon, CircleCheckIcon, GaugeIcon, HashIcon, ListChecksIcon, RulerIcon, TagIcon } from "@/components/icons";
import { fmt, fmtPct, fmtRate, msaPath, typeOf } from "../../lib/msa";
import { formatDay } from "../../lib/qualityAlerts";
import { Progress, StatusPill, ValidityPill, VerdictPill } from "./shared";

const head = (Icon, label, cls = "table-header") => (
  <div className={cls}>
    {Icon && <Icon className="shrink-0" />} {label}
  </div>
);

const col = (id, headerString, header, cell, { size = 140, minSize = 70, maxSize = 500, sortKey, align, accessor } = {}) => ({
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

const plain = (fn) => (info) => <div className="table-row-item">{fn(info.row.original) || "—"}</div>;

/** The headline figure each kind of study is judged on, in words: %GRR, Cgk, or effectiveness. */
export const headlineWords = (s) => {
  const h = s.headline;
  if (!h) return "";
  if (s.studyType === "grr_crossed") return h.pctGrr == null ? "" : `${fmtPct(h.pctGrr)} of the study variation`;
  if (s.studyType === "type1") return h.cgk == null ? "" : `Cgk ${fmt(h.cgk, 2)}`;
  return h.effectiveness == null ? "" : `${fmtRate(h.effectiveness, 0)} effective`;
};

export const msaColumns = [
  col(
    "reference",
    "Study",
    head(HashIcon, "Study"),
    (i) => (
      <Link to={msaPath(i.row.original.id)} className="table-row-item font-medium text-link-color hover:underline" onClick={(e) => e.stopPropagation()}>
        {i.row.original.reference}
      </Link>
    ),
    { size: 150, sortKey: "reference" }
  ),
  col("studyType", "Kind", head(TagIcon, "Kind"), plain((r) => typeOf(r.studyType).short), { size: 130, sortKey: "type" }),
  col(
    "gauge",
    "Gauge",
    head(GaugeIcon, "Gauge"),
    (i) => (
      <div className="table-row-item">
        <span className="block truncate font-medium">{i.row.original.gauge?.assetNumber}</span>
        <span className="block truncate text-xs text-secondary-text">{i.row.original.gauge?.description}</span>
      </div>
    ),
    { size: 200, sortKey: "gauge", accessor: (r) => r.gauge?.assetNumber }
  ),
  col(
    "characteristicName",
    "Measuring",
    head(RulerIcon, "Measuring"),
    (i) => {
      const s = i.row.original;
      return (
        <div className="table-row-item">
          <span className="block truncate">{s.characteristicName}</span>
          {s.part && <span className="block truncate text-xs text-secondary-text">{s.part.partNumber}</span>}
        </div>
      );
    },
    { size: 240, minSize: 120, maxSize: 600, sortKey: "characteristic" }
  ),
  col("status", "State", head(CircleCheckIcon, "State"), (i) => <StatusPill status={i.row.original.status} />, { size: 170, sortKey: "status" }),
  col("progress", "Readings", head(ListChecksIcon, "Readings"), (i) => <div className="table-row-item"><Progress progress={i.row.original.progress} /></div>, { size: 170, accessor: (r) => r.progress?.filled }),
  col("verdict", "Result", head(CircleCheckIcon, "Result"), (i) => <div className="table-row-item"><VerdictPill verdict={i.row.original.verdict} /></div>, { size: 140, sortKey: "verdict" }),
  col("headline", "Headline", head(RulerIcon, "Headline"), plain(headlineWords), { size: 200, accessor: (r) => headlineWords(r) }),
  col(
    "validUntil",
    "Valid",
    head(CalendarIcon, "Valid"),
    (i) => <div className="table-row-item"><ValidityPill validity={i.row.original.validity} validUntil={i.row.original.validUntil ? formatDay(i.row.original.validUntil) : null} /></div>,
    { size: 220, sortKey: "validUntil" }
  ),
  col("startedAt", "Started", head(CalendarIcon, "Started"), (i) => <div className="table-row-item whitespace-nowrap">{i.row.original.startedAt ? formatDay(i.row.original.startedAt.slice(0, 10)) : "—"}</div>, { size: 140 }),
  col("completedAt", "Completed", head(CalendarIcon, "Completed"), (i) => <div className="table-row-item whitespace-nowrap">{i.row.original.completedAt ? formatDay(i.row.original.completedAt.slice(0, 10)) : "—"}</div>, { size: 140, sortKey: "completedAt" }),
  col("createdAt", "Created", head(CalendarIcon, "Created"), (i) => <div className="table-row-item whitespace-nowrap">{formatDay(i.row.original.createdAt?.slice(0, 10))}</div>, { size: 140, sortKey: "createdAt" }),
];

/** Shown until a user changes the column set. */
export const DEFAULT_HIDDEN = { startedAt: false, completedAt: false, createdAt: false };
