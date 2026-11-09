import { Link } from "react-router-dom";
import { usePermissions } from "../../hooks/useQmsApi";
import { useGaugeUsage } from "../../hooks/useInspection";
import { describeApiError } from "../../lib/api-client";
import { formatDate, formatDateTime } from "../../lib/processControl";
import Callout from "../ui/Callout";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2";

/**
 * Impact assessment for a calibration found out of tolerance: the inspections that used the gauge
 * since its previous calibration. A report only — recorded results are never rewritten.
 */
const GaugeUsage = ({ calibrationId }) => {
  const { can } = usePermissions();
  const { data, isLoading, error } = useGaugeUsage(calibrationId);
  if (isLoading) return <p className="text-sm text-secondary-text">Looking for measurements made with this gauge…</p>;
  if (error) return <Callout tone="error" role="alert">{describeApiError(error)}</Callout>;
  const since = data.previous ? `since ${data.previous.reference} (${formatDate(data.previous.calibratedOn)})` : "since it was first used";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-primary-text">
        {data.totals.inspections === 0 ? (
          <>No in-process inspection used {data.gauge.assetNumber} {since}.</>
        ) : (
          <>
            <strong>{data.totals.readings}</strong> reading{data.totals.readings === 1 ? "" : "s"} in <strong>{data.totals.inspections}</strong> inspection
            {data.totals.inspections === 1 ? "" : "s"} used {data.gauge.assetNumber} {since}
            {data.totals.failedReadings ? `; ${data.totals.failedReadings} of them failed` : ""}. Review whether these results can still be trusted; nothing is changed automatically.
          </>
        )}
      </p>
      {data.inspections.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Inspections that used this gauge">
            <thead>
              <tr>
                <th scope="col" className={th}>Inspection</th>
                <th scope="col" className={th}>Part</th>
                <th scope="col" className={th}>Readings</th>
                <th scope="col" className={th}>Failed</th>
                <th scope="col" className={th}>Overrides</th>
                <th scope="col" className={th}>Used</th>
              </tr>
            </thead>
            <tbody>
              {data.inspections.map((i) => (
                <tr key={i.id}>
                  <td className={td}>
                    {can("inspection.read") ? (
                      <Link to={`/Inspections/${i.id}`} className="font-medium text-link-color hover:underline">
                        {i.reference}
                      </Link>
                    ) : (
                      i.reference
                    )}
                  </td>
                  <td className={td}>{i.partNumber}</td>
                  <td className={`${td} tabular-nums`}>{i.readings}</td>
                  <td className={`${td} tabular-nums`}>{i.failedReadings}</td>
                  <td className={`${td} tabular-nums`}>{i.overrides}</td>
                  <td className={`${td} whitespace-nowrap`}>
                    {formatDateTime(i.firstUsed)}
                    {i.lastUsed !== i.firstUsed && <> – {formatDateTime(i.lastUsed)}</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default GaugeUsage;
