import { useEffect, useState } from "react";
import { usePlatformOrganisations } from "../../hooks/usePlatform";
import { buttonClass } from "../master-data/shared";
import { Card, Panel, Pill, Table } from "./Panels";
import { day, pounds, statusTone } from "./format";

const PAGE = 25;

const Subscription = ({ o }) => {
  if (!o.subscriptionStatus) return <span className="text-secondary-text">{o.billingRequired ? "None yet" : "Not required"}</span>;
  const end = o.subscriptionStatus === "trialing" ? `trial ends ${day(o.trialEnd)}` : o.cancelAtPeriodEnd ? `ends ${day(o.currentPeriodEnd)}` : o.currentPeriodEnd ? `renews ${day(o.currentPeriodEnd)}` : "";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <Pill tone={statusTone(o.subscriptionStatus)}>{o.subscriptionStatus.replace("_", " ")}</Pill>
        <span className="text-xs text-secondary-text">{o.billingProvider === "stripe" ? "Stripe" : "manual"}{o.billingInterval ? `, ${o.billingInterval === "year" ? "annual" : "monthly"}` : ""}</span>
      </span>
      {end ? <span className="text-xs text-secondary-text">{end}</span> : null}
    </div>
  );
};

/** Every organisation: who owns it, how big it is, where its set-up and subscription stand. Billing and counts only. */
const OrganisationsPanel = () => {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(text);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [text]);
  const query = usePlatformOrganisations({ search, limit: PAGE, offset });
  return (
    <div className="flex flex-col gap-4">
      <label className="flex max-w-md flex-col gap-1 text-sm text-primary-text">
        Search organisations or owners
        <input type="search" aria-label="Search organisations" className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 text-sm text-primary-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or owner email" />
      </label>
      <Panel query={query}>
        {(res) => (
          <Card title={`Organisations (${res.total})`} subtitle="Counts and billing only: no records, documents or quality data">
            <Table
              caption="Organisations"
              head={["Organisation", "Owners", "Members", "Set-up", "Subscription", "Seats", "MRR"]}
              empty={res.data.length === 0 ? (search ? "No organisation matches." : "No organisations yet.") : null}>
              {res.data.map((o) => (
                <tr key={o.organisationId} className="border-b border-border-color align-top last:border-0">
                  <td className="py-2 pr-3 text-primary-text">
                    <span className="flex items-center gap-1.5">
                      {o.name}
                      {o.status !== "active" ? <Pill tone={statusTone(o.status)}>{o.status}</Pill> : null}
                    </span>
                    <span className="block text-xs text-secondary-text">Created {day(o.createdAt)}{o.country ? ` · ${o.country}` : ""}</span>
                  </td>
                  <td className="py-2 pr-3 text-primary-text">{o.ownerEmails.length ? o.ownerEmails.map((e) => <span key={e} className="block">{e}</span>) : "—"}</td>
                  <td className="py-2 pr-3 text-primary-text">{o.members}</td>
                  <td className="py-2 pr-3 text-primary-text">{o.setupFinishedAt ? <Pill tone="good">Done</Pill> : <Pill tone="quiet">In progress</Pill>}</td>
                  <td className="py-2 pr-3 text-primary-text"><Subscription o={o} /></td>
                  <td className="py-2 pr-3 text-primary-text">{o.seatsAssigned} / {o.seatsPurchased}</td>
                  <td className="py-2 text-primary-text">{o.mrrPence ? pounds(o.mrrPence) : "—"}</td>
                </tr>
              ))}
            </Table>
            {res.total > PAGE && (
              <div className="mt-3 flex items-center justify-between gap-2 text-sm text-secondary-text">
                <span>{offset + 1}–{Math.min(offset + PAGE, res.total)} of {res.total}</span>
                <span className="flex gap-2">
                  <button type="button" className={buttonClass.neutral} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
                  <button type="button" className={buttonClass.neutral} disabled={offset + PAGE >= res.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
                </span>
              </div>
            )}
          </Card>
        )}
      </Panel>
    </div>
  );
};

export default OrganisationsPanel;
