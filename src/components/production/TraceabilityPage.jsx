import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PrinterIcon, SearchIcon, TriangleAlertIcon } from "@/components/icons";
import { useDebouncedSearch } from "../../hooks/useDebouncedSearch";
import { useProductionSettings, useTraceability, useTraceSearch } from "../../hooks/useProduction";
import { usePermissions } from "../../hooks/useQmsApi";
import { STAGES, formatDate, ncrPath } from "../../lib/ncr";
import { LOT_STATUS, ORDER_STATUS, SERIAL_STATUS, TRACE_TYPE, partLabel, tracePath } from "../../lib/production";
import { formatDateTime } from "../../lib/processControl";
import { ErrorNotice, buttonClass } from "../master-data/shared";
import { ResultBadge, StatusPill } from "../inspection/shared";
import MenuCard from "../ui/MenuCard";
import { StatusBadge } from "./shared";

const STATUS_MAP = { order: ORDER_STATUS, lot: LOT_STATUS, serial: SERIAL_STATUS };
const STAGE = Object.fromEntries(STAGES.map((s) => [s.key, { label: s.label, className: s.tone }]));

const Fact = ({ label, children }) => (
  <div className="flex min-w-0 flex-col gap-0.5">
    <dt className="text-xs font-medium text-secondary-text">{label}</dt>
    <dd className="text-sm text-primary-text">{children || "—"}</dd>
  </div>
);
const Unavailable = ({ what }) => (
  <p role="status" className="flex items-start gap-2 rounded-lg border border-warning-color/40 bg-warning-color/10 px-3 py-2 text-sm text-primary-text">
    <TriangleAlertIcon className="mt-0.5 shrink-0 text-warning-color" aria-hidden="true" />
    You do not have access to {what}, so this section cannot say whether there are any. Ask someone who does if it matters.
  </p>
);
const Capped = ({ shown, total, what }) => (shown < total ? <p className="mt-2 text-xs text-secondary-text">Showing the latest {shown} of {total} {what}.</p> : null);
const Th = ({ children }) => <th className="py-1 pr-3 font-medium">{children}</th>;
const Td = ({ children, className = "" }) => <td className={`py-2 pr-3 align-top ${className}`}>{children}</td>;

/** Search box: type part of an order, lot or serial number, pick one. */
const Search = ({ onPick }) => {
  const [q, setSearch] = useDebouncedSearch();
  const [text, setText] = useState("");
  const results = useTraceSearch(q);
  return (
    <div className="flex flex-col gap-2 no-print">
      <label className="flex flex-col gap-1 text-sm font-medium text-primary-text">
        Find an order, lot or serial number
        <span className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-secondary-text" aria-hidden="true" />
          <input
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSearch(e.target.value);
            }}
            placeholder="WO-154789, LOT-9001, SN-0001…"
            className="w-full rounded-lg border border-border-color bg-primary-bg py-2 pl-9 pr-3 text-sm font-normal text-primary-text"
          />
        </span>
      </label>
      {q && results.data && (
        <ul aria-label="Matches" className="flex flex-col divide-y divide-border-color rounded-lg border border-border-color bg-secondary-bg">
          {results.data.length === 0 && <li className="px-3 py-2 text-sm text-secondary-text">Nothing has a number like “{q}”.</li>}
          {results.data.map((r) => (
            <li key={`${r.type}-${r.id}`}>
              <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-border-color/40 cursor-pointer" onClick={() => { onPick(r); setText(""); setSearch(""); }}>
                <span className="w-32 shrink-0 text-xs text-secondary-text">{TRACE_TYPE[r.type]}</span>
                <span className="font-medium text-primary-text">{r.number}</span>
                <span className="text-secondary-text">{partLabel(r.part)}</span>
                <span className="ml-auto"><StatusBadge map={STATUS_MAP[r.type]} status={r.status} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const Report = ({ type, id }) => {
  const query = useTraceability(type, id);
  const { can } = usePermissions();
  const settings = useProductionSettings();
  if (query.isLoading) return <p className="text-secondary-text">Loading…</p>;
  if (query.error || !query.data) return <ErrorNotice error={query.error ?? new Error("Not found")} />;
  const t = query.data;
  const s = t.subject;
  const showLots = settings.useLotsAndSerials || t.lots.total > 0;
  const showSerials = settings.useLotsAndSerials || t.serials.total > 0;

  return (
    <div id="trace-report" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-border-color bg-secondary-bg p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-secondary-text">Traceability report · {TRACE_TYPE[type]}</p>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold text-primary-text">{s.number}</h2>
          <StatusBadge map={STATUS_MAP[type]} status={s.status} />
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Part">
            <Link className="text-link-color hover:underline" to={`/Parts/${s.part.id}`}>{partLabel(s.part)}</Link>
          </Fact>
          <Fact label="Revision">{s.partRevision}</Fact>
          <Fact label="Customer">{s.customer?.name}</Fact>
          <Fact label="Supplier">{s.supplier?.name}</Fact>
          <Fact label="Site">{s.site?.name}</Fact>
          <Fact label="Quantity">{s.quantity?.toLocaleString()}</Fact>
          <Fact label="Inspections">{t.inspections.available ? String(t.inspections.total) : "Not available to you"}</Fact>
          <Fact label="Non-conformances">{t.ncrs.available ? String(t.ncrs.total) : "Not available to you"}</Fact>
        </dl>
        <p className="hidden text-xs text-secondary-text print:block">Printed {formatDateTime(new Date().toISOString())}</p>
      </div>

      {t.order && (
        <MenuCard title="Production order" subtitle={type === "order" ? "What was planned, and the route" : "The order this was made on"}>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Fact label="Order">
              {type === "order" ? t.order.orderNumber : <Link className="text-link-color hover:underline" to={tracePath("order", t.order.id)}>{t.order.orderNumber}</Link>}
            </Fact>
            <Fact label="Status"><StatusBadge map={ORDER_STATUS} status={t.order.status} /></Fact>
            <Fact label="Quantity planned">{t.order.quantityPlanned.toLocaleString()}</Fact>
            <Fact label="Due">{t.order.dueDate ? formatDate(t.order.dueDate) : null}</Fact>
          </dl>
          {t.order.operations.length > 0 && (
            <table className="mt-4 w-full text-sm" aria-label="Operations">
              <thead><tr className="text-left text-xs text-secondary-text"><Th>#</Th><Th>Operation</Th><Th>Description</Th><Th>Machine</Th><Th>Status</Th></tr></thead>
              <tbody>
                {t.order.operations.map((op) => (
                  <tr key={op.id} className="border-t border-border-color">
                    <Td className="tabular-nums text-secondary-text">{op.sequence}</Td>
                    <Td className="font-medium">{op.code}</Td>
                    <Td>{op.description ?? "—"}</Td>
                    <Td>{op.machine ? `${op.machine.code} · ${op.machine.name}` : "—"}</Td>
                    <Td>{op.status.replace(/_/g, " ")}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </MenuCard>
      )}

      {showLots && (
        <MenuCard title="Lots" subtitle={type === "serial" ? "The lot this serial number belongs to" : "Lots made for the order, or the lot itself"}>
          {t.lots.data.length === 0 ? (
            <p className="text-sm text-secondary-text">No lots. The order stands for everything made on it.</p>
          ) : (
            <table className="w-full text-sm" aria-label="Lots">
              <thead><tr className="text-left text-xs text-secondary-text"><Th>Lot</Th><Th>Origin</Th><Th>Quantity</Th><Th>Supplier</Th><Th>Status</Th></tr></thead>
              <tbody>
                {t.lots.data.map((l) => (
                  <tr key={l.id} className="border-t border-border-color">
                    <Td className="font-medium">{type === "lot" ? l.lotNumber : <Link className="text-link-color hover:underline" to={tracePath("lot", l.id)}>{l.lotNumber}</Link>}</Td>
                    <Td>{l.origin === "received" ? "Received" : "Produced"}</Td>
                    <Td className="tabular-nums">{l.quantity?.toLocaleString() ?? "—"}</Td>
                    <Td>{l.supplier?.name ?? "—"}</Td>
                    <Td><StatusBadge map={LOT_STATUS} status={l.status} />{l.statusReason && <span className="ml-2 text-xs text-secondary-text">{l.statusReason}</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Capped shown={t.lots.data.length} total={t.lots.total} what="lots" />
        </MenuCard>
      )}

      {showSerials && t.serials.data.length > 0 && (
        <MenuCard title="Serial numbers" subtitle="Each one, with its lot">
          <ul aria-label="Serial numbers" className="flex flex-wrap gap-2">
            {t.serials.data.map((x) => (
              <li key={x.id} className="rounded-full border border-border-color px-2 py-0.5 text-xs">
                {type === "serial" ? <span className="font-medium">{x.serialNumber}</span> : <Link className="text-link-color hover:underline" to={tracePath("serial", x.id)}>{x.serialNumber}</Link>}
                {x.lot && <span className="ml-1 text-secondary-text">· {x.lot.lotNumber}</span>}
                {x.status === "scrapped" && <span className="ml-1 text-error-color">· scrapped</span>}
              </li>
            ))}
          </ul>
          <Capped shown={t.serials.data.length} total={t.serials.total} what="serial numbers" />
        </MenuCard>
      )}

      <MenuCard title="Inspections" subtitle="What was measured, where and with what result">
        {!t.inspections.available ? (
          <Unavailable what="inspections" />
        ) : t.inspections.data.length === 0 ? (
          <p className="text-sm text-secondary-text">Nothing has been inspected against this {TRACE_TYPE[type].toLowerCase()}.</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-primary-text">
              {t.inspections.total} {t.inspections.total === 1 ? "inspection" : "inspections"}: {t.inspections.passed} passed, {t.inspections.failed} failed, {t.inspections.inProgress} in progress.
            </p>
            <table className="w-full text-sm" aria-label="Inspections">
              <thead><tr className="text-left text-xs text-secondary-text"><Th>Inspection</Th><Th>Started</Th><Th>Operation</Th><Th>Machine</Th><Th>Lot / serial</Th><Th>Status</Th><Th>Result</Th><Th>Failed readings</Th></tr></thead>
              <tbody>
                {t.inspections.data.map((i) => (
                  <tr key={i.id} className="border-t border-border-color">
                    <Td><Link className="font-medium text-link-color hover:underline" to={`/Inspections/${i.id}`}>{i.reference}</Link></Td>
                    <Td>{formatDateTime(i.startedAt)}</Td>
                    <Td>{i.operationCode ?? "All"}</Td>
                    <Td>{i.machine ? i.machine.code : "—"}</Td>
                    <Td>{[i.lot, i.serial].filter(Boolean).join(" · ") || "—"}</Td>
                    <Td><StatusPill status={i.status} /></Td>
                    <Td><ResultBadge result={i.result} /></Td>
                    <Td className="tabular-nums">{i.failures}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Capped shown={t.inspections.data.length} total={t.inspections.total} what="inspections" />
          </>
        )}
      </MenuCard>

      <MenuCard title="Non-conformances" subtitle="What was found wrong, what was contained and decided, and the 8Ds">
        {!t.ncrs.available ? (
          <Unavailable what="non-conformances" />
        ) : t.ncrs.data.length === 0 ? (
          <p className="text-sm text-secondary-text">No non-conformances are recorded against this {TRACE_TYPE[type].toLowerCase()}.</p>
        ) : (
          <>
            <table className="w-full text-sm" aria-label="Non-conformances">
              <thead><tr className="text-left text-xs text-secondary-text"><Th>NC</Th><Th>Stage</Th><Th>Affected</Th><Th>Found through</Th><Th>Containment</Th><Th>Dispositions</Th><Th>8D</Th></tr></thead>
              <tbody>
                {t.ncrs.data.map((n) => (
                  <tr key={n.id} className="border-t border-border-color">
                    <Td>
                      <Link className="font-medium text-link-color hover:underline" to={ncrPath(n.id)}>{n.reference}</Link>
                      <div className="text-xs text-secondary-text">{n.title}</div>
                    </Td>
                    <Td><StatusBadge map={STAGE} status={n.stage} /></Td>
                    <Td className="tabular-nums">{n.quantityAffected ?? "—"}</Td>
                    <Td>{n.matchedVia === "affected_lot" ? "Names an affected lot" : "Linked to it"}</Td>
                    <Td>{n.containment.open + n.containment.done === 0 ? "None recorded" : `${n.containment.done} done, ${n.containment.open} open`}</Td>
                    <Td>{n.dispositions.approved + n.dispositions.proposed === 0 ? "None" : `${n.dispositions.approved} approved (${n.dispositions.approvedQuantity})${n.dispositions.proposed ? `, ${n.dispositions.proposed} proposed` : ""}`}</Td>
                    <Td>{n.capas.length === 0 ? "—" : n.capas.map((c) => <Link key={c.id} className="mr-2 text-link-color hover:underline" to={`/CAPA/${c.id}/D0`}>{c.reference}</Link>)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Capped shown={t.ncrs.data.length} total={t.ncrs.total} what="non-conformances" />
          </>
        )}
      </MenuCard>

      <MenuCard title="Equipment" subtitle="The machines it ran on and the gauges it was measured with">
        {t.equipment.machines.length === 0 && t.equipment.gauges.length === 0 ? (
          <p className="text-sm text-secondary-text">No machine or gauge is recorded against it.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-medium text-primary-text">Machines</h3>
              {t.equipment.machines.length === 0 ? <p className="text-sm text-secondary-text">None.</p> : (
                <ul aria-label="Machines" className="flex flex-col gap-1 text-sm">
                  {t.equipment.machines.map((m) => (
                    <li key={m.id}><span className="font-medium">{m.code}</span> · {m.name} <span className="text-secondary-text">({m.operations} {m.operations === 1 ? "operation" : "operations"}, {m.inspections} {m.inspections === 1 ? "inspection" : "inspections"})</span></li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-sm font-medium text-primary-text">Gauges</h3>
              {!t.inspections.available ? <p className="text-sm text-secondary-text">Not available to you.</p> : t.equipment.gauges.length === 0 ? <p className="text-sm text-secondary-text">None recorded.</p> : (
                <ul aria-label="Gauges" className="flex flex-col gap-1 text-sm">
                  {t.equipment.gauges.map((g) => (
                    <li key={g.id}>
                      {can("calibration.read") ? <Link className="font-medium text-link-color hover:underline" to={`/Calibration/Gauges/${g.id}`}>{g.assetNumber}</Link> : <span className="font-medium">{g.assetNumber}</span>}{" "}
                      <span className="text-secondary-text">({g.readings} {g.readings === 1 ? "reading" : "readings"}, last {formatDateTime(g.lastUsed)})</span>
                      {g.outOfCalibration > 0 && <span className="ml-2 rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">{g.outOfCalibration} when out of calibration</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </MenuCard>
    </div>
  );
};

/** Traceability (/Production/Traceability?type=order|lot|serial&id=…): everything recorded against one order, lot or serial number, ready to print as a report. */
const TraceabilityPage = () => {
  const [params, setParams] = useSearchParams();
  const type = params.get("type");
  const id = params.get("id");
  const valid = ["order", "lot", "serial"].includes(type) && !!id;
  useEffect(() => {
    const previous = document.title;
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <div className="flex w-full min-w-0 flex-1 min-h-0 flex-col gap-4 overflow-auto bg-primary-bg p-4">
      <style>{"@media print { body * { visibility: hidden !important; } #trace-report, #trace-report * { visibility: visible !important; } #trace-report { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; } .no-print { display: none !important; } }"}</style>
      <div className="flex flex-wrap items-start justify-between gap-3 no-print">
        <div>
          <h1 className="text-xl font-semibold text-primary-text">Traceability</h1>
          <p className="text-sm text-secondary-text">Where an order, lot or serial number was made, measured, found wrong and dealt with.</p>
        </div>
        {valid && (
          <button type="button" className={buttonClass.secondary} onClick={() => window.print()}>
            <PrinterIcon className="mr-1 inline" aria-hidden="true" /> Print or save as PDF
          </button>
        )}
      </div>
      <Search onPick={(r) => setParams({ type: r.type, id: r.id })} />
      {valid ? <Report key={`${type}-${id}`} type={type} id={id} /> : <p className="text-sm text-secondary-text no-print">Search for a number above, or open this page from an order, lot, serial number, inspection or non-conformance.</p>}
    </div>
  );
};

export default TraceabilityPage;
