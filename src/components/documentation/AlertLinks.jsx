import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import RHFComboBox from "../ui/RHFComboBox";
import { NcrPicker, PartyPicker, RemoteComboBox } from "../ncr/Pickers";
import { useGauges, useGaugeCalibrations } from "../../hooks/useCalibration";
import { LINK_KINDS, linkHref } from "../../lib/qualityAlerts";

const useDebounced = (delay = 300) => {
  const [term, setTerm] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(term.trim()), delay);
    return () => clearTimeout(t);
  }, [term, delay]);
  return [q, setTerm];
};

const GaugePicker = ({ label, onChange }) => {
  const [q, setSearch] = useDebounced();
  const gauges = useGauges({ q, pageSize: 10, sort: "assetNumber" });
  return (
    <RemoteComboBox
      label={label}
      placeholder="Search asset number or description…"
      value={null}
      items={(gauges.data?.data ?? []).map((g) => ({ id: g.id, name: g.assetNumber, hint: g.description }))}
      isFetching={gauges.isFetching}
      onSearch={setSearch}
      onChange={onChange}
    />
  );
};

const CalibrationPicker = ({ onPick }) => {
  const [gauge, setGauge] = useState(null);
  const calibrations = useGaugeCalibrations(gauge?.id);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <GaugePicker label="Gauge, to choose one of its calibrations" onChange={(id, item) => setGauge(id ? { id, name: item?.name } : null)} />
      <RHFComboBox
        label="Add a calibration"
        placeholder={gauge ? "Choose a calibration…" : "Choose a gauge first"}
        disabled={!gauge}
        value={null}
        options={(calibrations.data ?? []).map((c) => ({ id: c.id, name: c.reference, hint: c.calibratedOn }))}
        sort={false}
        onChange={(id) => {
          const c = (calibrations.data ?? []).find((x) => x.id === id);
          if (c) onPick({ kind: "calibration", recordId: c.id, label: `${c.reference} (${gauge.name})`, gaugeId: gauge.id });
        }}
      />
    </div>
  );
};

/** Pickers for the records an alert refers to (draft editor). `links` are { kind, recordId, label, source?, gaugeId? }; onAdd/onRemove change them. */
export const LinksEditor = ({ links, onAdd, onRemove }) => {
  const add = (l) => !links.some((x) => x.kind === l.kind && x.recordId === l.recordId) && onAdd(l);
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-1.5" aria-label="Linked records">
        {links.map((l) => (
          <li key={`${l.kind}:${l.recordId}`} className="flex items-center gap-1 rounded-full border border-border-color px-2 py-0.5 text-sm text-primary-text">
            <span className="text-secondary-text">{LINK_KINDS[l.kind].label}:</span> {l.label ?? "Not available to you"}
            <button type="button" aria-label={`Remove link to ${l.label ?? LINK_KINDS[l.kind].label}`} className="text-secondary-text hover:text-error-color cursor-pointer" onClick={() => onRemove(l)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NcrPicker label="Add a nonconformance" value={null} onChange={(id, item) => id && add({ kind: "nonconformance", recordId: id, label: item?.name ?? "Nonconformance", source: item?.source ?? null })} />
        <PartyPicker kind="suppliers" label="Add a supplier" value={null} onChange={(id, item) => id && add({ kind: "supplier", recordId: id, label: item?.name ?? "Supplier" })} />
        <GaugePicker label="Add a gauge" onChange={(id, item) => id && add({ kind: "gauge", recordId: id, label: item ? `${item.name}${item.hint ? ` · ${item.hint}` : ""}` : "Gauge" })} />
      </div>
      <CalibrationPicker onPick={add} />
    </div>
  );
};

/** Read-only list of the linked records, each opening its own page when the reader may see it. */
export const LinkList = ({ links }) =>
  links.length === 0 ? (
    <p className="text-sm text-secondary-text">Nothing linked.</p>
  ) : (
    <ul className="flex flex-col gap-1 text-sm" aria-label="Linked records">
      {links.map((l) => {
        const href = l.label ? linkHref(l) : null;
        return (
          <li key={l.id} className="flex flex-wrap items-baseline gap-2">
            <span className="w-32 text-secondary-text">{LINK_KINDS[l.kind].label}</span>
            {href ? (
              <Link to={href} className="text-link-color hover:underline">{l.label}</Link>
            ) : (
              <span className="text-primary-text">{l.label ?? "Not available to you"}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
