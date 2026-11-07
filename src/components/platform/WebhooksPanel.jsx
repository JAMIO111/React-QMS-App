import { useState } from "react";
import { usePlatformWebhooks } from "../../hooks/usePlatform";
import { Card, Panel, Table, Tile, Tiles } from "./Panels";
import { ago, when } from "./format";

const WINDOWS = [
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];
const STALE_AFTER_HOURS = 24;

/** Is Stripe reaching us, and is what arrives being handled? The first place a broken webhook shows. */
const WebhooksPanel = () => {
  const [hours, setHours] = useState(24);
  const query = usePlatformWebhooks(hours);
  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="Window" className="flex gap-1">
        {WINDOWS.map((w) => (
          <button key={w.hours} type="button" aria-pressed={hours === w.hours} onClick={() => setHours(w.hours)} className={`rounded-lg border px-3 py-1.5 text-sm cursor-pointer ${hours === w.hours ? "border-brand-primary bg-brand-primary/10 text-primary-text" : "border-border-color text-secondary-text hover:text-primary-text"}`}>
            {w.label}
          </button>
        ))}
      </div>
      <Panel query={query}>
        {(w) => {
          const silent = !w.lastReceivedAt || Date.now() - new Date(w.lastReceivedAt).getTime() > STALE_AFTER_HOURS * 3600 * 1000;
          return (
            <div className="flex flex-col gap-4">
              {silent && (
                <p role="alert" className="rounded-xl border border-warning-color p-3 text-sm text-primary-text">
                  {w.lastReceivedAt ? `Stripe has not reached us for over ${STALE_AFTER_HOURS} hours (last event ${ago(w.lastReceivedAt)}).` : "Stripe has never reached us."} If you expect activity, check the endpoint's Recent deliveries in Stripe (the address, the signing secret, and Vercel deployment protection).
                </p>
              )}
              {w.stuck > 0 && (
                <p role="alert" className="rounded-xl border border-error-color p-3 text-sm text-primary-text">
                  {w.stuck} event{w.stuck === 1 ? " was" : "s were"} received but never finished. Stripe will retry; if it keeps happening, look at the failed list below.
                </p>
              )}
              <Tiles label="Webhook health">
                <Tile label="Last event" value={ago(w.lastReceivedAt)} tone={silent ? "warn" : undefined} hint={w.lastReceivedAt ? when(w.lastReceivedAt) : undefined} />
                <Tile label={`Received (${hours === 24 ? "24 h" : hours === 168 ? "7 d" : "30 d"})`} value={w.counts.received} />
                <Tile label="Processed" value={w.counts.processed} hint={`${w.counts.ignored} ignored`} />
                <Tile label="Failed" value={w.counts.failed} tone={w.counts.failed > 0 ? "bad" : undefined} />
              </Tiles>
              <Card title="Failed events" subtitle="The 25 most recent. Stripe retries a failed event, so one here usually means something needs fixing.">
                <Table caption="Failed events" head={["When", "Event", "Organisation", "Attempts", "Error"]} empty={w.failed.length === 0 ? "No failed events." : null}>
                  {w.failed.map((f) => (
                    <tr key={f.eventId} className="border-b border-border-color align-top last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap text-primary-text">{when(f.receivedAt)}</td>
                      <td className="py-2 pr-3 text-primary-text">{f.type}<span className="block text-xs text-secondary-text">{f.eventId}</span></td>
                      <td className="py-2 pr-3 text-primary-text">{f.organisation ?? "—"}</td>
                      <td className="py-2 pr-3 text-primary-text">{f.attempts}</td>
                      <td className="py-2 text-error-color">{f.error ?? "—"}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
              {w.types.length > 0 && (
                <Card title="What arrives" subtitle="Most frequent event types in the window">
                  <ul aria-label="Event types" className="flex flex-col gap-1 text-sm text-primary-text">
                    {w.types.map((t) => (
                      <li key={t.type} className="flex justify-between gap-3"><span>{t.type}</span><strong>{t.count}</strong></li>
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

export default WebhooksPanel;
