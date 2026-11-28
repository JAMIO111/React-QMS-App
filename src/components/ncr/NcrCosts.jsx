import { useRef, useState } from "react";
import Switch from "@/components/ui/Switch";
import { ArrowRightLeftIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Dialog from "../ui/Dialog";
import Callout from "../ui/Callout";
import CostForm from "./CostForm";
import RateDialog from "./RateDialog";
import ReasonDialog from "./ReasonDialog";
import { useNcrCosts, useNcrMutation } from "../../hooks/useNcr";
import { costDelete, costRestore } from "../../lib/ncrGuesses";
import { useOrganisationDetails, useSites } from "../../hooks/useQmsApi";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { RATE_STATUS, costTypeName, formatMoney, formatQuantity, formatRate, formatUnitMoney, isCreditType, signedBase, spentInEachCurrency, totalsRateState } from "../../lib/costs";
import { formatDate } from "../../lib/ncr";
import { newClientKey } from "../../lib/clientKey";
import LoadingScreen from "../ui/LoadingScreen";

/**
 * Cost lines of an NCR (ported from the original CostData): a headline total in the currency of the NC's site (net, with recoveries and charges taken off),
 * what was actually spent in each currency, and a table of lines with the exchange rate each was converted at (estimated from the published rate, actual
 * when someone stated it, or still needed). Add / edit in a dialog (a new line starts in the NC's site currency), state the actual rate, delete with a
 * reason, show and restore deleted lines.
 */
const NcrCosts = ({ ncrId, siteId, canEdit }) => {
  const [showDeleted, setShowDeleted] = useState(false);
  const costs = useNcrCosts(ncrId, { deleted: showDeleted ? "include" : "exclude" });
  const org = useOrganisationDetails();
  const sites = useSites({ includeInactive: true });
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(null); // "new" | cost
  const [deleting, setDeleting] = useState(null);
  const [rating, setRating] = useState(null); // the line whose rate is being stated
  // Made when the Add dialog opens and kept for retries inside it, so a second click or a resend answers the line already made instead of adding another.
  const newLineKey = useRef(newClientKey());

  const settings = org.data?.settings ?? {};
  // The currency of the NC's site (the organisation's when it has no site): what lines are converted into and the headline total is in.
  const siteCurrency = (sites.data?.data ?? []).find((s) => s.id === siteId)?.currency;
  const baseCurrency = costs.data?.totals.baseCurrency ?? siteCurrency ?? settings.baseCurrency ?? "GBP";
  const rows = costs.data?.data ?? [];
  const totals = costs.data?.totals;

  const save = (body) =>
    mutation.mutate(
      editing === "new" ? { path: `/ncrs/${ncrId}/costs`, body: { ...body, clientKey: newLineKey.current } } : { path: `/ncr-costs/${editing.id}`, method: "PATCH", body },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: editing === "new" ? "Cost added." : "Cost updated." });
          setEditing(null);
        },
      }
    );

  const rateState = totalsRateState(totals?.rates);
  const waiting = totals?.rates?.needed ?? 0;
  const spent = spentInEachCurrency(totals?.byCurrency);
  const mixedCurrencies = (totals?.byCurrency ?? []).some((c) => c.currency !== baseCurrency);

  const stateRate = (body) =>
    mutation.mutate(
      { path: `/ncr-costs/${rating.id}/rate`, body },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: "Exchange rate stated." });
          setRating(null);
        },
      }
    );
  const resetRate = () =>
    mutation.mutate(
      { path: `/ncr-costs/${rating.id}/reset-rate` },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: "Using the published rate." });
          setRating(null);
        },
      }
    );

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex w-full flex-wrap items-end justify-between gap-3 px-1">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-xl font-semibold text-primary-text">Cost data</h3>
          <p className="text-sm text-secondary-text">Expenses caused by this non-conformance.</p>
        </div>
        <div className="flex items-center gap-3">
          <Switch className="text-sm text-secondary-text" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)}>
            Show deleted
          </Switch>
          {canEdit && (
            <CTAButton
              type="main"
              text="New item"
              icon={PlusIcon}
              callbackFn={() => {
                mutation.reset();
                newLineKey.current = newClientKey();
                setEditing("new");
              }}
            />
          )}
        </div>
      </div>

      {totals && totals.count > 0 && (
        <section aria-label="Cost summary" className="flex flex-col gap-2 rounded-xl border border-border-color bg-secondary-bg p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-sm text-secondary-text">Total cost, net of recoveries</p>
            <p className="text-2xl font-semibold text-primary-text">{formatMoney(totals.net, baseCurrency)}</p>
            {rateState && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${rateState === "actual" ? "bg-success-color/15 text-success-color" : "bg-warning-color/15 text-warning-color"}`}
                title={rateState === "actual" ? "Every converted line uses a rate someone stated" : rateState === "estimated" ? "Converted lines use the published exchange rate" : "Some lines use the published rate, some a stated one"}>
                {rateState === "actual" ? "Actual" : rateState === "estimated" ? "Estimated" : "Mixed"}
              </span>
            )}
          </div>
          <p className="text-sm text-secondary-text">
            Including VAT: <span className="text-primary-text">{formatMoney(totals.gross, baseCurrency)}</span>
            {totals.orgCurrency && totals.orgCurrency !== baseCurrency && (
              <>
                {" "}· In the organisation's currency ({totals.orgCurrency}): <span className="text-primary-text">{formatMoney(totals.netOrg, totals.orgCurrency)}</span>
              </>
            )}
          </p>
          {mixedCurrencies && (
            <p className="text-sm text-secondary-text">
              Spent: <span className="text-primary-text">{spent}</span>
            </p>
          )}
          {waiting > 0 && (
            <Callout tone="warning" role="status">
              {waiting} {waiting === 1 ? "line is" : "lines are"} waiting for an exchange rate and {waiting === 1 ? "is" : "are"} not in these totals yet. They are filled in
              automatically when a published rate is available{canEdit ? ", or you can state the rate on the line" : ""}.
            </Callout>
          )}
        </section>
      )}

      <div className="w-full overflow-x-auto rounded-xl border border-border-color bg-secondary-bg">
        <table className="w-full table-auto text-sm" aria-label="Costs">
          <thead className="bg-primary-bg text-primary-text">
            <tr className="border-b border-border-color">
              <th className="px-4 py-2 text-left">Date</th>
              <th className="px-4 py-2 text-left">Cost type</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-right">Qty</th>
              <th className="px-4 py-2 text-right">Unit cost</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2 text-left">Rate</th>
              <th className="px-4 py-2 text-right">Net ({baseCurrency})</th>
              <th className="px-4 py-2 text-right">Gross ({baseCurrency})</th>
              <th className="px-4 py-2 text-left">Added by</th>
              {canEdit && <th className="px-4 py-2"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody className="text-secondary-text">
            {costs.isLoading ? (
              <tr>
                <td colSpan={11}><LoadingScreen size="sm" /></td>
              </tr>
            ) : costs.error ? (
              <tr>
                <td colSpan={11} role="alert" className="py-4 text-center text-error-color">{describeApiError(costs.error)}</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-4 text-center text-muted">No cost items logged yet.</td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id} className={`border-t border-border-color hover:bg-border-color/10 ${c.deletedAt ? "opacity-60" : ""}`}>
                  <td className="px-4 py-2 whitespace-nowrap">{formatDate(c.incurredOn)}</td>
                  <td className="px-4 py-2 text-primary-text">
                    {costTypeName(c.costType)}
                    {isCreditType(c.costType) && <span className="ml-2 rounded-full bg-info-color/15 px-2 py-0.5 text-xs text-info-color">Credit</span>}
                  </td>
                  <td className="px-4 py-2">
                    {c.description || "—"}
                    {c.deletedAt && <span className="block text-xs text-error-color">Deleted: {c.deleteReason}</span>}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">{formatQuantity(c.quantity)}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">{formatUnitMoney(c.unitCost, c.currency)}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {formatMoney(c.grossAmount, c.currency)}
                    {c.vatTreatment !== "none" && <span className="block text-xs">inc. {formatMoney(c.vatAmount, c.currency)} VAT</span>}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <RateCell cost={c} />
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">{money(signedBase(c, "netBase"), c.baseCurrency)}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap text-primary-text">{money(signedBase(c, "grossBase"), c.baseCurrency)}</td>
                  <td className="px-4 py-2">{c.createdBy?.name ?? "—"}</td>
                  {canEdit && (
                    <td className="px-2 py-2">
                      <div className="flex justify-end gap-1">
                        {c.deletedAt ? (
                          <button type="button" aria-label={`Restore ${costTypeName(c.costType)} cost`} title="Restore"
                            onClick={() => mutation.mutate({ path: `/ncr-costs/${c.id}/restore`, guess: costRestore(c.id), failed: "Not restored" })}
                            className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer">
                            <RotateCcwIcon className="h-4 w-4" />
                          </button>
                        ) : (
                          <>
                            {c.currency !== c.baseCurrency && (
                              <button type="button" aria-label={`Exchange rate for ${costTypeName(c.costType)} cost`} title="State the exchange rate"
                                onClick={() => {
                                  mutation.reset();
                                  setRating(c);
                                }}
                                className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer">
                                <ArrowRightLeftIcon className="h-4 w-4" />
                              </button>
                            )}
                            <button type="button" aria-label={`Edit ${costTypeName(c.costType)} cost`} title="Edit"
                              onClick={() => {
                                mutation.reset();
                                setEditing(c);
                              }}
                              className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer">
                              <PencilIcon className="h-4 w-4" />
                            </button>
                            <button type="button" aria-label={`Delete ${costTypeName(c.costType)} cost`} title="Delete"
                              onClick={() => {
                                mutation.reset();
                                setDeleting(c);
                              }}
                              className="rounded-lg p-1.5 text-error-color hover:bg-border-color/50 cursor-pointer">
                              <Trash2Icon className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
          {totals && totals.count > 0 && (
            <tfoot className="bg-primary-bg text-primary-text">
              <tr className="border-t border-border-color font-semibold">
                <td colSpan={7} className="px-4 py-2">Total ({totals.count} {totals.count === 1 ? "item" : "items"}, net of recoveries)</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">{formatMoney(totals.net, totals.baseCurrency)}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">{formatMoney(totals.gross, totals.baseCurrency)}</td>
                <td colSpan={canEdit ? 2 : 1} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {editing && (
        <Dialog title={editing === "new" ? "New cost item" : "Edit cost item"} onClose={() => setEditing(null)} width="max-w-2xl">
          <CostForm
            cost={editing === "new" ? null : editing}
            baseCurrency={baseCurrency}
            defaultCurrency={siteCurrency}
            vatRate={settings.vatRate ?? 0.2}
            pending={mutation.isPending}
            error={mutation.error}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        </Dialog>
      )}
      {rating && <RateDialog cost={rating} pending={mutation.isPending} error={mutation.error} onSubmit={stateRate} onReset={resetRate} onClose={() => setRating(null)} />}
      {deleting && (
        <ReasonDialog
          title={`Delete ${costTypeName(deleting.costType).toLowerCase()} cost?`}
          label="Reason for deleting"
          confirmText="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={(reason) => {
            // Gone from the list at once (the totals follow with the refetch); a refusal puts it back and is told in a toast.
            mutation.mutate({ path: `/ncr-costs/${deleting.id}/delete`, body: { reason }, guess: costDelete(deleting.id, reason), failed: "Not deleted" });
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
};

/** A converted value, "—" while the line is waiting for a rate. */
const money = (v, currency) => (v === null ? "—" : formatMoney(v, currency));

/** How a line was converted: the rate, with whether it is a published estimate, a stated actual, or still needed. */
const RateCell = ({ cost: c }) => {
  if (c.rateStatus === "base") return <span className="text-muted">—</span>;
  const chip = {
    estimated: "bg-warning-color/15 text-warning-color",
    actual: "bg-success-color/15 text-success-color",
    needed: "bg-error-color/15 text-error-color",
  }[c.rateStatus];
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2">
        {c.exchangeRate !== null && <span className="text-primary-text">{formatRate(c.exchangeRate)}</span>}
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${chip}`}>{RATE_STATUS[c.rateStatus]}</span>
      </span>
      {c.rateStatus === "estimated" && c.rateDate && <span className="text-xs">ECB, {formatDate(c.rateDate)}</span>}
      {c.rateStatus === "actual" && c.estimatedRate && <span className="text-xs">published {formatRate(c.estimatedRate)}</span>}
      {c.rateStatus === "actual" && c.overrideNote && <span className="max-w-48 truncate text-xs" title={c.overrideNote}>{c.overrideNote}</span>}
    </span>
  );
};

export default NcrCosts;
