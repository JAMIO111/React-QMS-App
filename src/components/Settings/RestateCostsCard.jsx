import { useState } from "react";
import Dialog from "../ui/Dialog";
import Callout from "../ui/Callout";
import CTAButton from "../CTAButton";
import MenuCard from "../ui/MenuCard";
import { useRestateCosts, useRestateReport } from "../../hooks/useCostCurrency";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";

/**
 * Cost lines recorded before sites had their own currency are stated in the organisation's. For a site whose currency differs, this lists them and
 * restates them into the site's currency at the published rates for the day each cost was incurred (the organisation figures stay exactly as they
 * were). Shown only when there is something to restate; nothing changes until it is confirmed.
 */
const RestateCostsCard = () => {
  const report = useRestateReport();
  const restate = useRestateCosts();
  const { showToast } = useToast();
  const [site, setSite] = useState(null);
  const sites = report.data?.sites ?? [];
  if (!sites.length) return null;

  const confirm = () =>
    restate.mutate(
      { siteId: site.siteId, confirm: true },
      {
        onSuccess: (r) => {
          showToast({ type: "success", title: "Costs restated", message: `${r.restated} ${r.restated === 1 ? "line" : "lines"} restated${r.needed ? `; ${r.needed} still need a rate` : ""}.` });
          setSite(null);
        },
      }
    );

  return (
    <MenuCard title="Costs stated in another currency" subtitle="Cost lines recorded before sites had their own currency">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-secondary-text">
          These lines are stated in a different currency from their site's. Restating converts them into the site's currency at the published exchange rate for the day each cost
          was incurred, marked as estimates. The organisation-wide figures do not change.
        </p>
        <ul className="flex flex-col divide-y divide-border-color rounded-lg border border-border-color">
          {sites.map((s) => (
            <li key={s.siteId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="text-primary-text">
                {s.name} ({s.siteCurrency}): {s.lines} {s.lines === 1 ? "line" : "lines"} stated in {s.statedIn.join(", ")}
              </span>
              <CTAButton type="secondary" text="Restate…" callbackFn={() => { restate.reset(); setSite(s); }} />
            </li>
          ))}
        </ul>
      </div>
      {site && (
        <Dialog title={`Restate costs at ${site.name}`} onClose={() => setSite(null)}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-secondary-text">
              {site.lines} {site.lines === 1 ? "line" : "lines"} stated in {site.statedIn.join(", ")} will be converted into {site.siteCurrency}
              {site.missing.length ? `, after fetching ${site.missing.length} published ${site.missing.length === 1 ? "rate" : "rates"} that ${site.missing.length === 1 ? "is" : "are"} not stored yet` : ""}. A line with no
              published rate is marked “Rate needed” and you can state the rate on the line.
            </p>
            {restate.error && <Callout tone="error" role="alert">{describeApiError(restate.error)}</Callout>}
            <div className="flex justify-end gap-2">
              <CTAButton type="neutral" size="md" text="Cancel" callbackFn={() => setSite(null)} />
              <CTAButton type="main" size="md" text="Restate costs" callbackFn={confirm} loading={restate.isPending} disabled={restate.isPending} />
            </div>
          </div>
        </Dialog>
      )}
    </MenuCard>
  );
};

export default RestateCostsCard;
