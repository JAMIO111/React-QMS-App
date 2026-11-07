import { useState } from "react";
import { Link } from "react-router-dom";
import { usePlatformMe, usePlatformOverview } from "../../hooks/usePlatform";
import MenuCard from "../ui/MenuCard";
import NotFound from "../NotFound";
import { ErrorNotice } from "../master-data/shared";

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/** One step of the funnel: a count, the share of the people before it, and a bar scaled to the first step. */
const Step = ({ label, count, of, first }) => (
  <li className="flex flex-col gap-1">
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-secondary-text">{label}</span>
      <span className="text-2xl font-semibold text-primary-text">{count}</span>
    </div>
    <div className="h-2 overflow-hidden rounded-full bg-border-color" aria-hidden="true">
      <div className="h-full rounded-full bg-brand-primary" style={{ width: first > 0 ? `${Math.max(2, (count / first) * 100)}%` : "0%" }} />
    </div>
    <span className="text-xs text-secondary-text">{of === null ? "People who signed themselves up" : `${pct(count, of)} of the step before`}</span>
  </li>
);

const StatusPill = ({ row }) => {
  const [text, tone] = row.orgStartedAt ? ["Organisation started", "bg-success-color/15 text-success-color"] : row.verifiedAt ? ["Verified", "bg-info-color/15 text-info-color"] : ["Awaiting verification", "bg-warning-color/20 text-primary-text"];
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{text}</span>;
};

const Monitor = () => {
  const [days, setDays] = useState(30);
  const query = usePlatformOverview(days);
  const o = query.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-secondary-text">Read-only. What is happening to sign-ups; no organisation&apos;s business data is shown here.</p>
        <div role="group" aria-label="Period" className="flex gap-1">
          {PERIODS.map((p) => (
            <button key={p.days} type="button" aria-pressed={days === p.days} onClick={() => setDays(p.days)} className={`rounded-lg border px-3 py-1.5 text-sm cursor-pointer ${days === p.days ? "border-brand-primary bg-brand-primary/10 text-primary-text" : "border-border-color text-secondary-text hover:text-primary-text"}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {query.error && <ErrorNotice error={query.error} />}
      {query.isLoading && <p className="text-sm text-secondary-text">Loading…</p>}
      {o && (
        <>
          <MenuCard title="Sign-up funnel" subtitle={`People who created an account themselves in the last ${o.funnel.days} days`}>
            <ol aria-label="Sign-up funnel" className="grid grid-cols-1 gap-5 md:grid-cols-3">
              <Step label="Signed up" count={o.funnel.signedUp} of={null} first={o.funnel.signedUp} />
              <Step label="Verified their email" count={o.funnel.verified} of={o.funnel.signedUp} first={o.funnel.signedUp} />
              <Step label="Started an organisation" count={o.funnel.orgStarted} of={o.funnel.verified} first={o.funnel.signedUp} />
            </ol>
          </MenuCard>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MenuCard title="Accounts" subtitle="All time">
              <p className="text-3xl font-semibold text-primary-text">{o.funnel.totalAccounts}</p>
            </MenuCard>
            <MenuCard title="Organisations" subtitle="All time">
              <p className="text-3xl font-semibold text-primary-text">{o.funnel.totalOrganisations}</p>
            </MenuCard>
          </div>
          <MenuCard title="Latest sign-ups" subtitle="The 25 most recent">
            {o.recentSignups.length === 0 ? (
              <p className="text-sm text-secondary-text">Nobody has signed up yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Latest sign-ups</caption>
                  <thead>
                    <tr className="border-b border-border-color text-secondary-text">
                      <th className="py-2 pr-3 font-medium">Person</th>
                      <th className="py-2 pr-3 font-medium">Signed up</th>
                      <th className="py-2 pr-3 font-medium">Organisation</th>
                      <th className="py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.recentSignups.map((r) => (
                      <tr key={r.userId} className="border-b border-border-color last:border-0">
                        <td className="py-2 pr-3 text-primary-text">
                          {r.name ?? "—"}
                          <span className="block text-xs text-secondary-text">{r.email}</span>
                        </td>
                        <td className="py-2 pr-3 text-primary-text">{when(r.signedUpAt)}</td>
                        <td className="py-2 pr-3 text-primary-text">{r.organisationName ?? "—"}</td>
                        <td className="py-2"><StatusPill row={r} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </MenuCard>
        </>
      )}
    </div>
  );
};

/** The operator's area (/platform): for accounts on the platform allow-list whose session has passed two-factor authentication. Everyone else sees "not found". */
const PlatformPage = () => {
  const me = usePlatformMe();
  if (me.isLoading) return <p className="p-6 text-sm text-secondary-text">Loading…</p>;
  if (me.error || me.data?.status === "none") return <NotFound />;
  return (
    <main className="min-h-screen w-full overflow-y-auto bg-primary-bg p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-primary-text">Fortress QMS · Platform</h1>
          <Link to="/Dashboard" className="text-sm text-link-color hover:underline">
            Back to the app
          </Link>
        </header>
        {me.data?.status === "needs_mfa" ? (
          <MenuCard title="Two-factor authentication needed" subtitle="Platform administration needs a session that has passed two-factor authentication">
            <p className="text-sm text-primary-text">
              <Link to={`/mfa?next=${encodeURIComponent("/platform")}`} className="text-link-color underline">
                Verify with your authenticator app
              </Link>{" "}
              (or set one up first in Settings → Account), then come back here.
            </p>
          </MenuCard>
        ) : (
          <Monitor />
        )}
      </div>
    </main>
  );
};

export default PlatformPage;
