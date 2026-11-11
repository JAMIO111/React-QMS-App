import { useState } from "react";
import { usePlatformEmail } from "../../hooks/usePlatform";
import { Card, Panel, Table, Tile, Tiles } from "./Panels";
import { ago, when } from "./format";
import Callout from "../ui/Callout";
import SlidingToggle from "../ui/SlidingToggle";

const WINDOWS = [
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

/** Are notification emails going out? Counts, the provider and failures only — never a subject, a body or an address. */
const EmailPanel = () => {
  const [hours, setHours] = useState(24);
  const query = usePlatformEmail(hours);
  return (
    <div className="flex flex-col gap-4">
      <SlidingToggle ariaLabel="Window" options={WINDOWS.map((w) => ({ value: w.hours, label: w.label }))} value={hours} onChange={setHours} />
      <Panel query={query}>
        {(e) => {
          const c = e.counts ?? {};
          const stuck = e.oldestWaiting && Date.now() - new Date(e.oldestWaiting).getTime() > 3600 * 1000;
          return (
            <div className="flex flex-col gap-4">
              {!e.sending && (
                <Callout tone="info" title="No mail provider">
                  Emails are built and kept in the outbox, marked not sent. Set MAIL_PROVIDER=resend with RESEND_API_KEY and MAIL_FROM on the API to send them.
                </Callout>
              )}
              {stuck && (
                <Callout tone="warning" title="Emails are waiting">
                  The oldest has waited since {when(e.oldestWaiting)}. The queue is worked after each change and by the daily cron; check the provider and the API logs.
                </Callout>
              )}
              <Tiles label="Email health">
                <Tile label="Provider" value={e.provider === "none" ? "None" : e.provider} tone={e.sending ? undefined : "warn"} />
                <Tile label="Sent" value={c.sent ?? 0} hint={e.lastSent ? `last ${ago(e.lastSent)}` : "never"} />
                <Tile label="Not sent (no provider)" value={c.unsent ?? 0} />
                <Tile label="Waiting" value={e.waiting ?? 0} tone={stuck ? "warn" : undefined} />
                <Tile label="Failed" value={c.failed ?? 0} tone={(c.failed ?? 0) > 0 ? "bad" : undefined} />
              </Tiles>
              <Card title="Problems" subtitle="Failed emails and ones being tried again, most recent first (up to 25).">
                <Table caption="Email problems" head={["When", "Organisation", "Event", "Status", "Attempts", "Error"]} empty={(e.problems ?? []).length === 0 ? "No problems." : null}>
                  {(e.problems ?? []).map((p, i) => (
                    <tr key={`${p.at}-${i}`} className="border-b border-border-color align-top last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap text-primary-text">{when(p.at)}</td>
                      <td className="py-2 pr-3 text-primary-text">{p.organisation}</td>
                      <td className="py-2 pr-3 text-primary-text">{p.event}</td>
                      <td className="py-2 pr-3 text-primary-text">{p.status === "queued" ? "Trying again" : "Failed"}</td>
                      <td className="py-2 pr-3 text-primary-text">{p.attempts}</td>
                      <td className="py-2 text-error-color">{p.error ?? "—"}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
              {(e.byEvent ?? []).length > 0 && (
                <Card title="What is emailed" subtitle="Emails by kind of notice in the window">
                  <ul aria-label="Emails by event" className="flex flex-col gap-1 text-sm text-primary-text">
                    {e.byEvent.map((b) => (
                      <li key={b.event} className="flex justify-between gap-3"><span>{b.event}</span><strong>{b.count}</strong></li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          );
        }}
      </Panel>
    </div>
  );
};

export default EmailPanel;
