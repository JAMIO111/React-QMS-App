import { useState } from "react";
import Switch from "@/components/ui/Switch";
import { PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Dialog from "../ui/Dialog";
import CostForm from "./CostForm";
import ReasonDialog from "./ReasonDialog";
import { useNcrCosts, useNcrMutation } from "../../hooks/useNcr";
import { useOrganisationDetails, useSites } from "../../hooks/useQmsApi";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { costTypeName, formatMoney } from "../../lib/costs";
import { formatDate } from "../../lib/ncr";
import LoadingScreen from "../ui/LoadingScreen";

/**
 * Cost lines of an NCR (ported from the original CostData): table with totals in the
 * organisation's base currency, add / edit in a dialog (a new line starts in the NC's site currency), delete with a reason, show and restore
 * deleted lines.
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

  const settings = org.data?.settings ?? {};
  const baseCurrency = costs.data?.totals.baseCurrency ?? settings.baseCurrency ?? "GBP";
  // A new cost line starts in the currency of the site the NC was raised at (its own currency, else the organisation's).
  const siteCurrency = (sites.data?.data ?? []).find((s) => s.id === siteId)?.currency;
  const rows = costs.data?.data ?? [];
  const totals = costs.data?.totals;

  const save = (body) =>
    mutation.mutate(
      editing === "new" ? { path: `/ncrs/${ncrId}/costs`, body } : { path: `/ncr-costs/${editing.id}`, method: "PATCH", body },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: editing === "new" ? "Cost added." : "Cost updated." });
          setEditing(null);
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
                setEditing("new");
              }}
            />
          )}
        </div>
      </div>

      <div className="w-full overflow-x-auto rounded-xl border border-border-color bg-secondary-bg">
        <table className="w-full table-auto text-sm" aria-label="Costs">
          <thead className="bg-primary-bg text-primary-text">
            <tr className="border-b border-border-color">
              <th className="px-4 py-2 text-left">Date</th>
              <th className="px-4 py-2 text-left">Cost type</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2 text-right">Net ({baseCurrency})</th>
              <th className="px-4 py-2 text-right">Gross ({baseCurrency})</th>
              <th className="px-4 py-2 text-left">Added by</th>
              {canEdit && <th className="px-4 py-2"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody className="text-secondary-text">
            {costs.isLoading ? (
              <tr>
                <td colSpan={8}><LoadingScreen size="sm" /></td>
              </tr>
            ) : costs.error ? (
              <tr>
                <td colSpan={8} role="alert" className="py-4 text-center text-error-color">{describeApiError(costs.error)}</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-4 text-center text-muted">No cost items logged yet.</td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id} className={`border-t border-border-color hover:bg-border-color/10 ${c.deletedAt ? "opacity-60" : ""}`}>
                  <td className="px-4 py-2 whitespace-nowrap">{formatDate(c.incurredOn)}</td>
                  <td className="px-4 py-2 text-primary-text">{costTypeName(c.costType)}</td>
                  <td className="px-4 py-2">
                    {c.description || "—"}
                    {c.deletedAt && <span className="block text-xs text-error-color">Deleted: {c.deleteReason}</span>}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {formatMoney(c.grossAmount, c.currency)}
                    {c.vatTreatment !== "none" && <span className="block text-xs">inc. {formatMoney(c.vatAmount, c.currency)} VAT</span>}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">{formatMoney(c.netBase, baseCurrency)}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap text-primary-text">{formatMoney(c.grossBase, baseCurrency)}</td>
                  <td className="px-4 py-2">{c.createdBy?.name ?? "—"}</td>
                  {canEdit && (
                    <td className="px-2 py-2">
                      <div className="flex justify-end gap-1">
                        {c.deletedAt ? (
                          <button type="button" aria-label={`Restore ${costTypeName(c.costType)} cost`} title="Restore" disabled={mutation.isPending}
                            onClick={() => mutation.mutate({ path: `/ncr-costs/${c.id}/restore` }, { onError: (e) => showToast({ type: "error", title: "Not restored", message: describeApiError(e) }) })}
                            className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer">
                            <RotateCcwIcon className="h-4 w-4" />
                          </button>
                        ) : (
                          <>
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
                <td colSpan={4} className="px-4 py-2">Total ({totals.count} {totals.count === 1 ? "item" : "items"})</td>
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
      {deleting && (
        <ReasonDialog
          title={`Delete ${costTypeName(deleting.costType).toLowerCase()} cost?`}
          label="Reason for deleting"
          confirmText="Delete"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setDeleting(null)}
          onConfirm={(reason) =>
            mutation.mutate(
              { path: `/ncr-costs/${deleting.id}/delete`, body: { reason } },
              {
                onSuccess: () => {
                  showToast({ type: "success", title: "Deleted", message: "Cost removed from the totals." });
                  setDeleting(null);
                },
              }
            )
          }
        />
      )}
    </div>
  );
};

export default NcrCosts;
