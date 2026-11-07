import { usePlatformPayments } from "../../hooks/usePlatform";
import { Card, Panel, Pill, Table, Tile, Tiles } from "./Panels";
import { day, pounds, statusTone, when } from "./format";

/** Invoices across organisations, and the payments that failed. */
const PaymentsPanel = () => {
  const query = usePlatformPayments(50);
  return (
    <Panel query={query}>
      {(p) => (
        <div className="flex flex-col gap-4">
          <Tiles label="Last 30 days">
            <Tile label="Paid" value={pounds(p.paidLast30DaysPence)} hint="Including VAT" />
            <Tile label="VAT in that" value={pounds(p.taxLast30DaysPence)} />
            <Tile label="Failed payments" value={p.failedLast30Days} tone={p.failedLast30Days > 0 ? "bad" : undefined} />
          </Tiles>
          {p.failedPayments.length > 0 && (
            <Card title="Failed payments" subtitle="Last 30 days">
              <ul aria-label="Failed payments" className="flex flex-col gap-1 text-sm text-primary-text">
                {p.failedPayments.map((f, i) => (
                  <li key={`${f.organisationId}-${i}`} className="flex flex-wrap justify-between gap-2">
                    <span><strong>{f.organisation}</strong>{f.invoice ? ` · ${f.invoice}` : ""}</span>
                    <span className="text-secondary-text">{pounds(f.amount, f.currency)} · {when(f.at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Latest invoices" subtitle="Across all organisations">
            <Table caption="Latest invoices" head={["Invoice", "Organisation", "Date", "Net", "VAT", "Total", "Status"]} empty={p.invoices.length === 0 ? "No invoices yet." : null}>
              {p.invoices.map((i) => (
                <tr key={i.id} className="border-b border-border-color last:border-0">
                  <td className="py-2 pr-3 text-primary-text">{i.number ?? "—"}</td>
                  <td className="py-2 pr-3 text-primary-text">{i.organisation}</td>
                  <td className="py-2 pr-3 text-primary-text">{day(i.paidAt ?? i.invoiceDate)}</td>
                  <td className="py-2 pr-3 text-primary-text">{pounds(i.subtotal, i.currency)}</td>
                  <td className="py-2 pr-3 text-primary-text">{pounds(i.tax, i.currency)}</td>
                  <td className="py-2 pr-3 text-primary-text">{pounds(i.total, i.currency)}</td>
                  <td className="py-2"><Pill tone={statusTone(i.status)}>{i.status}</Pill></td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </Panel>
  );
};

export default PaymentsPanel;
