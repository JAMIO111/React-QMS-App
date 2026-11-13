import { useState } from "react";
import { Link } from "react-router-dom";
import { FlaskConicalIcon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import MenuCard from "../ui/MenuCard";
import { useTestWorkflowRule, useWorkflowTestEvents } from "../../hooks/useWorkflows";
import { describeApiError } from "../../lib/api-client";
import { OP_LABELS, describeAction, needsValue, ruleContent } from "../../lib/workflows";

const at = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Test the rule as it is on screen (saved or not) against a recent event: which conditions hold, and whom each action would reach. Nothing is saved or sent.
 * `problems` (from the builder) must be empty first.
 */
const RuleTest = ({ draft, problems, labels, trigger }) => {
  const events = useWorkflowTestEvents(draft.trigger);
  const test = useTestWorkflowRule();
  const [eventId, setEventId] = useState(null);
  const chosen = events.data?.find((e) => e.eventId === eventId) ?? null;
  const result = test.data && test.data.eventId === eventId ? test.data : null;
  const names = { ...labels, ...(result?.labels ?? {}) };
  const content = draft.trigger ? ruleContent(draft) : null;
  const blocking = problems.filter((p) => !p.startsWith("Give the rule a name"));

  return (
    <MenuCard title="Test the rule" subtitle="Against something that happened recently. Nothing is saved or sent.">
      {!draft.trigger ? (
        <p className="text-sm text-secondary-text">Choose what starts the rule first.</p>
      ) : events.isLoading ? (
        <p className="text-sm text-secondary-text">Loading recent events…</p>
      ) : events.error ? (
        <Callout tone="error">{describeApiError(events.error)}</Callout>
      ) : !events.data?.length ? (
        <p className="text-sm text-secondary-text">Nothing like this has happened in the last 90 days that you may read, so there is nothing to test against yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <ComboField
              className="min-w-72 flex-1"
              label="Test against"
              value={eventId}
              onChange={setEventId}
              options={events.data.map((e) => ({ value: e.eventId, label: e.record.label, hint: at(e.at) }))}
              placeholder="Choose a recent event…"
            />
            <CTAButton
              type="secondary"
              icon={FlaskConicalIcon}
              disabled={!eventId || blocking.length > 0}
              loading={test.isPending}
              onClick={() => test.mutate({ ...content, eventId })}
            >
              Run the test
            </CTAButton>
          </div>
          {blocking.length > 0 && <p className="text-xs text-secondary-text">Finish the rule first: {blocking[0].toLowerCase()}.</p>}
          {chosen && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" aria-label="What the record says">
              {chosen.facts.map((f) => (
                <div key={f.field} className="contents">
                  <dt className="text-secondary-text">{f.label}</dt>
                  <dd className="text-primary-text">{f.words ?? "—"}</dd>
                </div>
              ))}
            </dl>
          )}
          {test.error && <Callout tone="error" role="alert">{describeApiError(test.error)}</Callout>}
          {result && (
            <div className="flex flex-col gap-3" aria-live="polite">
              <Callout tone={result.matched ? "success" : "info"} title={result.matched ? "The rule would run" : "The rule would not run"}>
                For{" "}
                {result.record.path ? (
                  <Link to={result.record.path} className="underline">
                    {result.record.label}
                  </Link>
                ) : (
                  result.record.label
                )}
                .
              </Callout>
              {[...result.conditions.all, ...result.conditions.any].length > 0 && (
                <ul className="flex flex-col gap-1 text-sm" aria-label="Conditions">
                  {[...result.conditions.all, ...result.conditions.any].map((c, i) => {
                    const field = chosen?.facts.find((f) => f.field === c.field);
                    const values = Array.isArray(c.value) ? c.value : c.value ? [c.value] : [];
                    return (
                      <li key={i} className={c.holds ? "text-success-color" : "text-error-color"}>
                        {c.holds ? "✓" : "✗"} {c.label} {OP_LABELS[c.op]}
                        {needsValue(c.op) ? ` ${values.map((v) => names[v] ?? v).join(", ")}` : ""}
                        <span className="text-secondary-text"> — it is {field?.words ?? "empty"}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <ul className="flex flex-col gap-2 text-sm" aria-label="What it would do">
                {result.actions.map((a) => {
                  const told = a.people.filter((p) => p.told);
                  const notTold = a.people.filter((p) => !p.told);
                  return (
                    <li key={a.index} className="rounded-lg border border-border-color p-2">
                      <p className="text-primary-text">{describeAction(content.actions[a.index], names, trigger)}</p>
                      {a.type === "later" ? (
                        <p className="text-secondary-text">
                          {!result.matched
                            ? "Not started: the conditions do not hold."
                            : `Would wait ${a.afterDays} day${a.afterDays === 1 ? "" : "s"}, then read the record again. As it is today, ${a.stillNow?.holds ? "it would go ahead" : "it would stop there"}${
                                a.stillNow?.holds && a.inner?.length
                                  ? `: ${a.inner.map((x) => (x.type === "hold_lot" ? "the lot would be held" : x.people.filter((p) => p.told).map((p) => p.name).join(", ") || "nobody")).join("; ")}`
                                  : ""
                              }.`}
                        </p>
                      ) : a.type === "hold_lot" ? (
                        <p className="text-secondary-text">{result.matched ? "Would put the record's lot on hold (if it names one), with the authority of whoever saves this version." : "Not done: the conditions do not hold."}</p>
                      ) : !result.matched ? (
                        <p className="text-secondary-text">Not done: the conditions do not hold.</p>
                      ) : told.length ? (
                        <p className="text-secondary-text">
                          {a.type === "task" ? "Would go to" : "Would tell"} {told.map((p) => p.name).join(", ")}
                          {a.total > a.people.length ? ` and ${a.total - a.people.length} more` : ""}.
                        </p>
                      ) : (
                        <p className="text-error-color">Would reach nobody{a.type === "task" ? ": there is nobody who may read the record to give it to" : ""}.</p>
                      )}
                      {result.matched && notTold.length > 0 && (
                        <p className="text-secondary-text">Not told, because they may not read this record: {notTold.map((p) => p.name).join(", ")}.</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </MenuCard>
  );
};

export default RuleTest;
