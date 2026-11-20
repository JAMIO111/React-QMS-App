import { useState } from "react";
import Dialog from "../ui/Dialog";
import SlidingToggle from "../ui/SlidingToggle";
import TextInput from "../ui/TextInput";
import Callout from "../ui/Callout";
import CTAButton from "../CTAButton";
import { TextAreaField } from "./Pickers";
import { describeApiError } from "../../lib/api-client";
import { costTypeName, formatMoney, formatRate, rateDifference } from "../../lib/costs";
import { formatDate } from "../../lib/ncr";

/**
 * State the exchange rate that was actually got for a cost line: either the rate itself, or the converted amount from the invoice or bank statement (the
 * rate is then worked out from the amount that was entered, so VAT is never guessed). The line becomes "Actual"; the published rate stays beside it for
 * comparison and the change is on the NC's history. "Use the published rate" drops a stated rate (or tries again for a line still waiting).
 */
const RateDialog = ({ cost, onSubmit, onReset, onClose, pending, error }) => {
  const [kind, setKind] = useState("rate");
  const [value, setValue] = useState(cost.rateStatus === "actual" && cost.overrideKind === "rate" && cost.exchangeRate ? String(cost.exchangeRate) : "");
  const [note, setNote] = useState("");
  const number = value === "" ? null : Number(value);
  const valid = number !== null && Number.isFinite(number) && number > 0;
  const entered = cost.amount; // what was typed on the line, in its own currency
  const rate = !valid ? null : kind === "rate" ? number : entered > 0 ? number / entered : null;
  const published = cost.estimatedRate ?? (cost.rateStatus === "estimated" ? cost.exchangeRate : null);
  const sign = cost.costSign ?? 1;
  const money = (v) => (v === null ? "—" : `${sign < 0 ? "−" : ""}${formatMoney(v, cost.baseCurrency)}`);
  const net = rate === null ? null : Math.round(cost.netAmount * rate * 100) / 100;
  const gross = rate === null ? null : Math.round(cost.grossAmount * rate * 100) / 100;
  const difference = rate !== null ? rateDifference(rate, published) : null;

  return (
    <Dialog title={`Exchange rate: ${costTypeName(cost.costType)}`} onClose={onClose} width="max-w-xl">
      <form
        aria-label="State the exchange rate"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit({ kind, value: number, note: note.trim() || null });
        }}
        className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          {formatMoney(entered, cost.currency)} entered on {formatDate(cost.incurredOn)}, converted to {cost.baseCurrency}.{" "}
          {published ? (
            <>The published rate is <span className="text-primary-text">1 {cost.currency} = {formatRate(published)} {cost.baseCurrency}</span>{cost.rateDate ? ` (${formatDate(cost.rateDate)})` : ""}.</>
          ) : (
            <>There is no published rate for this line yet.</>
          )}
        </p>
        <SlidingToggle
          ariaLabel="What you know"
          mode="radio"
          options={[
            { value: "rate", label: "The rate" },
            { value: "amount", label: "The converted amount" },
          ]}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setValue("");
          }}
        />
        <TextInput
          label={kind === "rate" ? `Rate (1 ${cost.currency} = ? ${cost.baseCurrency})` : `Converted amount in ${cost.baseCurrency} (of ${formatMoney(entered, cost.currency)})`}
          required
          dataType="number"
          placeholder={kind === "rate" ? "1.00" : "0.00"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          hint={kind === "amount" ? "As charged on the invoice or bank statement, for the amount entered on the line." : undefined}
        />
        <dl aria-label="Result" className="grid grid-cols-3 gap-2 rounded-xl border border-border-color bg-secondary-bg p-3 text-sm">
          <div>
            <dt className="text-secondary-text">Rate</dt>
            <dd className="font-semibold text-primary-text">{rate === null ? "—" : formatRate(rate)}</dd>
          </div>
          <div>
            <dt className="text-secondary-text">Net in {cost.baseCurrency}</dt>
            <dd className="font-semibold text-primary-text">{money(net)}</dd>
          </div>
          <div>
            <dt className="text-secondary-text">Gross in {cost.baseCurrency}</dt>
            <dd className="font-semibold text-primary-text">{money(gross)}</dd>
          </div>
          {difference && (
            <div className="col-span-3 text-secondary-text">
              {difference} compared with the published rate ({formatRate(published)}).
            </div>
          )}
        </dl>
        <TextAreaField label="Note" value={note} onChange={setNote} maxLength={500} hint="Optional: where the rate came from, such as the bank or the invoice number." />
        {error && <Callout tone="error" role="alert">{describeApiError(error)}</Callout>}
        <div className="flex flex-wrap justify-between gap-2">
          {onReset && (cost.rateStatus === "actual" || cost.rateStatus === "needed") ? (
            <CTAButton buttonType="button" type="secondary" size="md" onClick={onReset} disabled={pending}>
              {cost.rateStatus === "actual" ? "Use the published rate" : "Try the published rate again"}
            </CTAButton>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
              Cancel
            </CTAButton>
            <CTAButton buttonType="submit" type="success" size="md" disabled={!valid || pending} loading={pending}>
              {pending ? "Saving…" : "Save rate"}
            </CTAButton>
          </div>
        </div>
      </form>
    </Dialog>
  );
};

export default RateDialog;
