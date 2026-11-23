import { costSummaryWords } from "../../lib/integrations";
import Callout from "../ui/Callout";
import MenuCard from "../ui/MenuCard";

const lines = (n) => `${n.toLocaleString("en-GB")} line${n === 1 ? "" : "s"}`;

/**
 * Shown above the mapping of NC cost lines (cost-import-plan §3.3): nothing is converted in the file. A rate is looked up for each line's own
 * incurred date, so a file with every line in a different currency imports as it is.
 */
export const CostCurrencyNotice = () => (
  <Callout tone="info" title="Currencies and exchange rates" role="note">
    Map the amount and its currency as they are in your file. Fortress converts each line on its own incurred date, into the currency of the non-conformance&apos;s site and
    into the organisation&apos;s, and never reads a rate from the file. A line whose currency has no published rate yet is still imported and fills in when the rate arrives.
    Map <span className="font-medium">Value in the site currency</span> only if your source booked a converted value you want kept instead.
  </Callout>
);

/**
 * What a cost import does about currencies, from the run (a preview too): per currency how many lines have a published rate for their date and how many
 * will wait, how many land on closed or cancelled non-conformances, how many carry the source's booked value, and, once written, how many still wait.
 */
const CostRunCard = ({ run, preview }) => {
  const costs = run.costs;
  if (!costs || costs.lines === 0) return null;
  const words = costSummaryWords(costs);
  const currencies = costs.currencies ?? [];
  return (
    <MenuCard title="Currencies and rates" subtitle={`${lines(costs.lines)} · ${words?.sentence ?? ""}`}>
      <div className="flex flex-col gap-3">
        {currencies.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border-color">
            <table className="w-full text-sm">
              <caption className="sr-only">Cost lines by currency and whether an exchange rate is published for their date</caption>
              <thead>
                <tr className="bg-secondary-bg text-left text-xs uppercase tracking-wide text-tertiary-text">
                  <th scope="col" className="px-3 py-2 font-medium">Currency</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Lines</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">With a rate</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Waiting for a rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-color">
                {currencies.map((c) => (
                  <tr key={c.currency}>
                    <th scope="row" className="px-3 py-2 text-left font-mono font-medium text-primary-text">{c.currency}</th>
                    <td className="px-3 py-2 text-right text-primary-text">{c.lines.toLocaleString("en-GB")}</td>
                    <td className="px-3 py-2 text-right text-primary-text">{c.withRate.toLocaleString("en-GB")}</td>
                    <td className={`px-3 py-2 text-right ${c.waiting > 0 ? "font-medium text-warning-color" : "text-secondary-text"}`}>{c.waiting.toLocaleString("en-GB")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {words?.waiting > 0 && (
          <Callout tone="warning" title={words.waiting === 1 ? "1 line will wait for a rate" : `${words.waiting} lines will wait for a rate`} role="status">
            {preview ? "They import" : "They were imported"} without a converted value: until the rate is published they add to no total, and Fortress fills them in on its own once it is.
            Nothing needs doing.
          </Callout>
        )}
        {!preview && costs.waitingNow > 0 && (
          <Callout tone="warning" title={costs.waitingNow === 1 ? "1 imported line is still waiting for a rate" : `${costs.waitingNow} imported lines are still waiting for a rate`} role="status">
            They show as &ldquo;waiting for a rate&rdquo; on their non-conformance and are filled in automatically when the rate is published.
          </Callout>
        )}
        {(costs.onClosed > 0 || costs.onCancelled > 0) && (
          <Callout tone="info" title="Lines on closed or cancelled non-conformances">
            {[costs.onClosed > 0 ? `${lines(costs.onClosed)} on closed non-conformances` : null, costs.onCancelled > 0 ? `${lines(costs.onCancelled)} on cancelled ones` : null].filter(Boolean).join(" and ")}.
            {" "}They are accepted only when the template allows costs on closed or cancelled non-conformances an import brought in; otherwise the rows are rejected.
          </Callout>
        )}
        {costs.datedFromNc > 0 && (
          <Callout tone="info" title="Lines dated from their non-conformance">
            {lines(costs.datedFromNc)} had no date, so {preview ? "will take" : "took"} the date their non-conformance was detected, and the exchange rate for that day.
            If a non-conformance was imported without a detected date, that date is the day it was imported.
          </Callout>
        )}
        {costs.booked > 0 && (
          <p className="text-sm text-secondary-text">
            {lines(costs.booked)} carr{costs.booked === 1 ? "ies" : "y"} the value your source booked in the site currency. Where a conversion is needed, that value is kept and the line shows as Actual.
          </p>
        )}
      </div>
    </MenuCard>
  );
};

export default CostRunCard;
