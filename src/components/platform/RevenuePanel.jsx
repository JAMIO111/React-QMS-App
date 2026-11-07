import { usePlatformRevenue } from "../../hooks/usePlatform";
import { Card, Panel, Table, Tile, Tiles } from "./Panels";
import { pounds } from "./format";

const STATUS_LABELS = { active: "Active", trialing: "Trialing", past_due: "Past due", unpaid: "Unpaid", paused: "Paused", incomplete: "Incomplete", cancelled: "Cancelled" };

/** Revenue from Stripe-billed subscriptions. */
const RevenuePanel = () => {
  const query = usePlatformRevenue();
  return (
    <Panel query={query}>
      {(r) => (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-secondary-text">Stripe-billed subscriptions, excluding VAT. Paying means active or past due (still owed); trials are what they pay if they convert.</p>
          <Tiles label="Revenue">
            <Tile label="MRR" value={pounds(r.mrrPence, r.currency)} hint="Monthly recurring revenue" />
            <Tile label="ARR" value={pounds(r.arrPence, r.currency)} hint="MRR × 12" />
            <Tile label="Trial MRR" value={pounds(r.trialMrrPence, r.currency)} hint="If every trial converts" />
            <Tile label="Past due" value={r.pastDue} tone={r.pastDue > 0 ? "warn" : undefined} hint="Payment failed, still in grace or being retried" />
          </Tiles>
          <Tiles label="Movement">
            <Tile label="Trials ending in 7 days" value={r.trialsEndingSoon} />
            <Tile label="Set to cancel" value={r.cancelling} hint="Ends at the period end" />
            <Tile label="New (30 days)" value={r.newLast30Days} />
            <Tile label="Cancelled (30 days)" value={r.cancelledLast30Days} />
          </Tiles>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card title="Seats" subtitle="Active, trialing and past-due subscriptions">
              <Table caption="Seats by package" head={["Package", "Bought", "Assigned", "Unused"]}>
                {r.seats.map((s) => (
                  <tr key={s.slug} className="border-b border-border-color last:border-0">
                    <td className="py-2 pr-3 text-primary-text">{s.name}</td>
                    <td className="py-2 pr-3 text-primary-text">{s.purchased}</td>
                    <td className="py-2 pr-3 text-primary-text">{s.assigned}</td>
                    <td className="py-2 text-primary-text">{Math.max(0, s.purchased - s.assigned)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
            <Card title="Subscriptions by status">
              {Object.keys(r.byStatus).length === 0 ? (
                <p className="text-sm text-secondary-text">No Stripe subscriptions yet.</p>
              ) : (
                <ul aria-label="Subscriptions by status" className="flex flex-col gap-1 text-sm text-primary-text">
                  {Object.entries(r.byStatus).map(([status, n]) => (
                    <li key={status} className="flex justify-between gap-3">
                      <span>{STATUS_LABELS[status] ?? status}</span>
                      <strong>{n}</strong>
                    </li>
                  ))}
                </ul>
              )}
              {Object.keys(r.payingByInterval).length > 0 && (
                <p className="mt-3 text-xs text-secondary-text">
                  Paying: {Object.entries(r.payingByInterval).map(([i, n]) => `${n} ${i === "year" ? "annual" : "monthly"}`).join(", ")}
                </p>
              )}
            </Card>
          </div>
        </div>
      )}
    </Panel>
  );
};

export default RevenuePanel;
