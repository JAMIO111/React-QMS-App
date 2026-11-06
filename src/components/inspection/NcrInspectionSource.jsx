import { Link } from "react-router-dom";
import { formatDateTime } from "../../lib/processControl";
import { ResultBadge } from "./shared";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";

const Value = ({ valueNumeric, valuePass, valueCount, unitCode }) =>
  valueCount !== null && valueCount !== undefined ? (
    <span className="tabular-nums">
      {valueCount} {valueCount === 1 ? "defect" : "defects"}
    </span>
  ) : valueNumeric !== null && valueNumeric !== undefined ? (
    <span className="tabular-nums">
      {valueNumeric}
      {unitCode ? ` ${unitCode}` : ""}
    </span>
  ) : (
    <span>{valuePass ? "Pass" : "Fail"}</span>
  );

/**
 * The inspection(s) a non-conformance was raised from, with the exact readings: value, limits, result,
 * gauge — and what a later correction made of them (the NC keeps pointing at the original reading).
 */
const NcrInspectionSource = ({ source }) => (
  <div className="flex flex-col gap-4">
    {source.inspections.map((i) => (
      <div key={i.id} className="flex flex-col gap-2">
        <p className="text-sm text-primary-text">
          <Link to={`/Inspections/${i.id}`} className="font-medium text-link-color hover:underline">
            {i.reference}
          </Link>{" "}
          · {i.part.partNumber} · {i.plan.planCode} rev {i.plan.revisionCode}
          {i.operationCode ? ` · ${i.operationCode}` : ""} · started {formatDateTime(i.startedAt)}
          {i.wholeInspection && <span className="ml-2 rounded-full bg-border-color px-2 py-0.5 text-xs text-secondary-text">Raised for the inspection as a whole</span>}
        </p>
        {i.readings.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm text-primary-text" aria-label={`Readings behind this NC from ${i.reference}`}>
              <thead>
                <tr>
                  <th scope="col" className={th}>Check</th>
                  <th scope="col" className={th}>Sample</th>
                  <th scope="col" className={th}>Reading</th>
                  <th scope="col" className={th}>Requirement</th>
                  <th scope="col" className={th}>Gauge</th>
                  <th scope="col" className={th}>Measured</th>
                </tr>
              </thead>
              <tbody>
                {i.readings.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>{r.requirementName}</td>
                    <td className={td}>#{r.sampleNumber}</td>
                    <td className={td}>
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <Value {...r} />
                        <ResultBadge result={r.result} />
                      </span>
                      {r.correctedTo && (
                        <div className="text-xs text-secondary-text">
                          Corrected later to <Value {...r.correctedTo} unitCode={r.unitCode} /> ({r.correctedTo.result})
                          {r.correctedTo.reason ? ` — “${r.correctedTo.reason}”` : ""}. The original reading stays on record.
                        </div>
                      )}
                    </td>
                    <td className={`${td} tabular-nums`}>{r.limits}</td>
                    <td className={td}>{r.gaugeAssetNumber ?? "—"}</td>
                    <td className={`${td} whitespace-nowrap`}>{formatDateTime(r.measuredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    ))}
  </div>
);

export default NcrInspectionSource;
