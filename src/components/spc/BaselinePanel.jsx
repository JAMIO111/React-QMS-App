import { useState } from "react";
import MenuCard from "../ui/MenuCard";
import Field from "../ui/Field";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCreateBaseline, useSpcBaselines } from "../../hooks/useSpc";
import { formatDateTime } from "../../lib/processControl";
import {
  BASIS_LABEL,
  RULES,
  RULE_LABEL,
  describeWindow,
  formatCount,
  formatPercent,
  formatValue,
} from "../../lib/spc";
import { FormError } from "../master-data/shared";
import CTAButton from "@/components/CTAButton";

const limitText = (b, v, decimals) =>
  b.chartType === "p" ? formatPercent(v, 2) : b.chartType === "defects" ? formatCount(v) : formatValue(v, decimals);
const dayStart = (d) =>
  d ? new Date(`${d}T00:00:00`).toISOString() : undefined;
const dayEnd = (d) =>
  d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined;

const Limits = ({ b, decimals }) =>
  b.chartType === "defects" ? (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
      {[
        ["Centre line ū (defects per unit)", formatCount(b.limits.centre)],
        ["Average subgroup size", `${Math.round((b.meanSubgroupSize ?? 0) * 10) / 10} units`],
        ["Limits at that size (per unit)", `${formatCount(b.limits.lcl)} to ${formatCount(b.limits.ucl)}`],
        ["Subgroup", BASIS_LABEL[b.subgroupBasis]],
      ].map(([k, v]) => (
        <div key={k}>
          <dt className="text-secondary-text">{k}</dt>
          <dd className="tabular-nums text-primary-text">{v}</dd>
        </div>
      ))}
    </dl>
  ) : b.chartType === "p" ? (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
      {[
        [
          "Centre line p̄ (proportion failed)",
          formatPercent(b.limits.centre, 2),
        ],
        [
          "Average subgroup size",
          `${Math.round((b.meanSubgroupSize ?? 0) * 10) / 10} checks`,
        ],
        [
          "Limits at that size",
          `${formatPercent(b.limits.lcl, 2)} to ${formatPercent(b.limits.ucl, 2)}`,
        ],
        ["Subgroup", BASIS_LABEL[b.subgroupBasis]],
      ].map(([k, v]) => (
        <div key={k}>
          <dt className="text-secondary-text">{k}</dt>
          <dd className="tabular-nums text-primary-text">{v}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
      {[
        ["Centre line", formatValue(b.limits.centre, decimals)],
        ["Upper control limit", formatValue(b.limits.ucl, decimals)],
        ["Lower control limit", formatValue(b.limits.lcl, decimals)],
        [
          b.chartType === "imr" ? "Average moving range" : "Average range",
          formatValue(b.limits.dispersionCentre, decimals),
        ],
      ].map(([k, v]) => (
        <div key={k}>
          <dt className="text-secondary-text">{k}</dt>
          <dd className="tabular-nums text-primary-text">
            {v} {b.unitCode ?? ""}
          </dd>
        </div>
      ))}
    </dl>
  );

/**
 * Saved control limits for the chosen characteristic: the one in use, the form to calculate and save a new
 * baseline from a window of data (quality engineers), and the history — superseded limits stay visible.
 */
const BaselinePanel = ({ chart, params, rules, decimals }) => {
  const { can } = usePermissions();
  const canManage = can("spc.manage");
  const history = useSpcBaselines({
    partId: params.partId,
    characteristicKey: params.characteristicKey,
    operationCode: params.operationCode,
  });
  const create = useCreateBaseline();
  const [mode, setMode] = useState("all"); // all | first | range
  const [firstN, setFirstN] = useState("25");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState(null);

  const submit = (e) => {
    e.preventDefault();
    const body = {
      partId: params.partId,
      characteristicKey: params.characteristicKey,
      operationCode: chart.characteristic.operationCode,
      rules,
      ...(isP ? { subgroup: params.subgroup ?? "inspection" } : {}),
      // The NP chart is a view of the pass/fail data: the limits are made from subgroups of the size it shows.
      ...(chart.variant === "np" && chart.subgroup?.size ? { size: chart.subgroup.size } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(mode === "first" ? { firstN: Number(firstN) } : {}),
      ...(mode === "range" ? { from: dayStart(from), to: dayEnd(to) } : {}),
    };
    create.mutate(body, { onSuccess: (b) => (setSaved(b), setNotes("")) });
  };
  const active = chart.baseline;
  const isP = chart.characteristic.chartType === "p" || chart.characteristic.chartType === "defects";
  const unit =
    chart.characteristic.chartType === "imr"
      ? "readings"
      : isP
        ? `subgroups (${BASIS_LABEL[params.subgroup ?? "inspection"]} each)`
        : "complete subgroups";

  return (
    <MenuCard
      title="Baseline (control limits)"
      subtitle="Limits calculated once from a chosen window of data and kept. A new baseline replaces the current one; the old limits stay in the history."
    >
      <div className="flex flex-col gap-4">
        {active ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-primary-text">
              In use: {describeWindow(active)} from{" "}
              {formatDateTime(active.windowFrom)} to{" "}
              {formatDateTime(active.windowTo)}, saved{" "}
              {formatDateTime(active.createdAt)}
              {active.createdBy ? ` by ${active.createdBy.name}` : ""}.
              {active.provisional && (
                <strong>
                  {" "}
                  Provisional: too few points for dependable limits.
                </strong>
              )}
            </p>
            <Limits b={active} decimals={decimals} />
            {active.notes && (
              <p className="text-sm text-secondary-text">“{active.notes}”</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-primary-text">
            No baseline saved. The chart shows trial limits calculated from the
            points on screen.
          </p>
        )}

        {canManage && chart.points.length > 0 && (
          <form
            onSubmit={submit}
            className="flex flex-col gap-3 rounded-lg border border-border-color p-3"
            aria-label="Save a baseline"
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-secondary-text">
                Data to calculate from
              </legend>
              {[
                ["all", `All ${unit} for this characteristic`],
                ["first", "The first N"],
                ["range", "A date range"],
              ].map(([value, label]) => (
                <label
                  key={value}
                  className="flex items-center gap-2 text-sm text-primary-text"
                >
                  <input
                    type="radio"
                    name="baseline-window"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {label}
                </label>
              ))}
              {mode === "first" && (
                <Field
                  label={`Number of ${unit}`}
                  type="number"
                  min={5}
                  max={5000}
                  value={firstN}
                  onChange={(e) => setFirstN(e.target.value)}
                  className="max-w-48"
                />
              )}
              {mode === "range" && (
                <div className="flex flex-wrap gap-3">
                  <RHFDatePickerPopout label="From" valueFormat="iso" clearable value={from} onChange={(d) => setFrom(d ?? "")} placeholder="Select a date" />
                  <RHFDatePickerPopout label="To" valueFormat="iso" clearable value={to} onChange={(d) => setTo(d ?? "")} placeholder="Select a date" />
                </div>
              )}
            </fieldset>
            <Field
              label="Note (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              hint="For example: stable run after the tool change"
            />
            <p className="text-xs text-secondary-text">
              Rules saved with the baseline:{" "}
              {rules.length
                ? rules.map((r) => RULE_LABEL[r].short).join(", ")
                : "none"}{" "}
              (as ticked above). At least 5 {unit} are needed; fewer than{" "}
              {chart.characteristic.chartType === "imr" ? 25 : 20} is saved as
              provisional.
            </p>
            <FormError error={create.error} />
            {saved && !create.error && (
              <p role="status" className="text-sm text-success-color">
                Baseline saved from {describeWindow(saved)}.
              </p>
            )}
            <div>
              <CTAButton
                buttonType="submit"
                type="main" size="lg"
                disabled={create.isPending} loading={create.isPending}
              >
                {active
                  ? "Calculate and replace baseline"
                  : "Calculate and save baseline"}
              </CTAButton>
            </div>
          </form>
        )}

        {history.data?.length > 0 && (
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[620px] border-separate border-spacing-0 text-sm text-primary-text"
              aria-label="Baseline history"
            >
              <thead>
                <tr>
                  {[
                    "Saved",
                    "By",
                    "Data",
                    "Centre",
                    "UCL",
                    "LCL",
                    "Status",
                  ].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.data.map((b) => (
                  <tr key={b.id}>
                    <td className="border-b border-border-color px-2 py-2 whitespace-nowrap">
                      {formatDateTime(b.createdAt)}
                    </td>
                    <td className="border-b border-border-color px-2 py-2">
                      {b.createdBy?.name ?? "—"}
                    </td>
                    <td className="border-b border-border-color px-2 py-2">
                      {describeWindow(b)}
                      {b.provisional ? " (provisional)" : ""}
                    </td>
                    <td className="border-b border-border-color px-2 py-2 tabular-nums">
                      {limitText(b, b.limits.centre, decimals)}
                    </td>
                    <td className="border-b border-border-color px-2 py-2 tabular-nums">
                      {limitText(b, b.limits.ucl, decimals)}
                    </td>
                    <td className="border-b border-border-color px-2 py-2 tabular-nums">
                      {limitText(b, b.limits.lcl, decimals)}
                    </td>
                    <td className="border-b border-border-color px-2 py-2">
                      {b.supersededAt
                        ? `Replaced ${formatDateTime(b.supersededAt)}`
                        : "Current"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MenuCard>
  );
};

export default BaselinePanel;
