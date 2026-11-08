import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { usePermissions } from "../../hooks/useQmsApi";
import { useAcknowledgeAlert, useSpcAlerts } from "../../hooks/useSpc";
import { formatDateTime } from "../../lib/processControl";
import { CHART_NAME } from "../../lib/spc";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const th = "border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text";
const td = "border-b border-border-color px-2 py-2 align-top";
const TABS = [
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "all", label: "All" },
];

const AcknowledgeDialog = ({ alert, onClose }) => {
  const mutation = useAcknowledgeAlert();
  const [note, setNote] = useState("");
  return (
    <Dialog title={`Acknowledge — ${alert.characteristicName}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ id: alert.id, note }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-primary-text">
          {alert.part.partNumber} · {alert.summary}. Say what was looked at or done about it; it is recorded with your name and the time, and an alert is acknowledged once.
        </p>
        <TextAreaField label="What was done" value={note} onChange={(e) => setNote(e.target.value)} required maxLength={2000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!note.trim() || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Acknowledge"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * Alerts raised when a newly recorded point breaks a control-chart rule. An alert is a prompt to look into the process: it
 * never raises a non-conformance by itself. Alerts are raised as samples are saved (not on a schedule) and acknowledged
 * once, with a note, by someone who manages SPC.
 */
const AlertsPage = () => {
  const [params, setParams] = useSearchParams();
  const status = TABS.some((t) => t.value === params.get("status")) ? params.get("status") : "open";
  const { can } = usePermissions();
  const canManage = can("spc.manage");
  const query = useSpcAlerts(status);
  const [acknowledging, setAcknowledging] = useState(null);
  const data = query.data?.data ?? [];

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-2xl font-semibold text-primary-text">SPC alerts</h1>
        <p className="text-sm text-secondary-text">
          Raised when a newly recorded point breaks a control-chart rule. They show where the process may be behaving differently; they do not mean product is nonconforming.
        </p>
      </div>

      <MenuCard
        title={status === "open" ? "Open alerts" : status === "acknowledged" ? "Acknowledged alerts" : "All alerts"}
        subtitle={query.data ? `${query.data.openCount} open` : undefined}
        action={
          <div role="tablist" aria-label="Alert status" className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={status === t.value}
                onClick={() => setParams(t.value === "open" ? {} : { status: t.value })}
                className={`rounded-lg border px-3 py-1 text-sm ${status === t.value ? "border-brand-primary bg-brand-primary/10 text-primary-text" : "border-border-color text-secondary-text"}`}>
                {t.label}
              </button>
            ))}
          </div>
        }>
        {query.isLoading && <p className="text-secondary-text">Loading alerts…</p>}
        {query.error && <ErrorNotice error={query.error} />}
        {query.data && data.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-primary-text">
            <CircleCheckIcon className="h-4 w-4" /> {status === "open" ? "No open alerts." : "No alerts to show."}
          </p>
        )}
        {data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="SPC alerts">
              <thead>
                <tr>
                  <th scope="col" className={th}>Raised</th>
                  <th scope="col" className={th}>Part · characteristic</th>
                  <th scope="col" className={th}>Signal</th>
                  <th scope="col" className={th}>Inspection</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={th}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id}>
                    <td className={`${td} whitespace-nowrap`}>{formatDateTime(a.raisedAt)}</td>
                    <td className={td}>
                      <Link
                        to={`/Process-Control/SPC?part=${a.part.id}&c=${encodeURIComponent(`${a.characteristicKey}|${a.operationCode}`)}`}
                        className="font-medium text-link-color hover:underline">
                        {a.part.partNumber} · {a.characteristicName}
                      </Link>
                      <span className="block text-xs text-secondary-text">
                        {a.operationCode} · {CHART_NAME[a.variant]?.split(" (")[0] ?? a.variant}
                      </span>
                    </td>
                    <td className={td}>
                      {a.summary}
                      {a.side ? <span className="block text-xs text-secondary-text">{a.side} the centre line · point at {formatDateTime(a.pointAt)}</span> : null}
                    </td>
                    <td className={td}>
                      {a.inspection ? (
                        <Link to={`/Inspections/${a.inspection.id}`} className="text-link-color hover:underline">
                          {a.inspection.reference ?? "Inspection"}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={td}>
                      {a.status === "open" ? (
                        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-error-color/15 px-2 py-0.5 text-xs font-medium text-error-color">
                          <CircleAlertIcon className="h-3.5 w-3.5" /> Open
                        </span>
                      ) : (
                        <span>
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-success-color/15 px-2 py-0.5 text-xs font-medium text-success-color">
                            <CircleCheckIcon className="h-3.5 w-3.5" /> Acknowledged
                          </span>
                          <span className="block text-xs text-secondary-text">
                            {a.acknowledgedBy?.name ?? "Someone"}, {formatDateTime(a.acknowledgedAt)}: “{a.note}”
                          </span>
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      {a.status === "open" && canManage && (
                        <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setAcknowledging(a)}>
                          Acknowledge
                        </CTAButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MenuCard>
      {acknowledging && <AcknowledgeDialog alert={acknowledging} onClose={() => setAcknowledging(null)} />}
    </div>
  );
};

export default AlertsPage;
