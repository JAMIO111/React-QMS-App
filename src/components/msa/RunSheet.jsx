import { useEffect, useMemo, useRef, useState } from "react";
import CTAButton from "@/components/CTAButton";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import SlidingToggle from "../ui/SlidingToggle";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { useParsePaste, useRecordMeasurements } from "../../hooks/useMsa";
import { cellKey, cellMap, isFilled, isNumberText, runSheet, toNumberText } from "../../lib/msa";

/** One reading box: shows what is stored, saves when it is left or Enter is pressed, and says so when what was typed is not a number. */
const ReadingBox = ({ cell, label, disabled, onSave }) => {
  const stored = cell?.value ?? "";
  const [text, setText] = useState(stored);
  const [focused, setFocused] = useState(false);
  // Enter saves and moves on, and leaving the box would save again before the screen has caught up: remember what was just sent.
  const sent = useRef(null);
  useEffect(() => {
    if (!focused) setText(stored);
  }, [stored, focused]);
  const invalid = text.trim() !== "" && !isNumberText(text);
  const commit = () => {
    const t = text.trim();
    if (t === "" || invalid || toNumberText(t) === stored || sent.current === t) return;
    sent.current = t;
    setTimeout(() => {
      sent.current = null;
    }, 0);
    onSave(toNumberText(t));
  };
  return (
    <input
      data-reading=""
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      title={invalid ? "Give a number" : cell?.enteredAt ? `Entered ${new Date(cell.enteredAt).toLocaleString("en-GB")}${cell.enteredBy ? ` by ${cell.enteredBy}` : ""}` : undefined}
      disabled={disabled}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        commit();
        const inputs = [...(e.currentTarget.closest("[data-sheet]")?.querySelectorAll("[data-reading]:not(:disabled)") ?? [])];
        inputs[inputs.indexOf(e.currentTarget) + 1]?.focus();
      }}
      className={`min-h-9.5 w-full min-w-24 rounded-lg border bg-text-input-color px-3 py-2 text-right font-mono text-sm tabular-nums outline-none transition-all duration-150 disabled:opacity-60 ${
        invalid ? "border-error-color focus:ring-3 focus:ring-error-color/20" : isFilled(cell) ? "border-success-color/60 focus:border-brand-primary focus:ring-3 focus:ring-brand-primary/20" : "border-border-color hover:border-border-dark-color focus:border-brand-primary focus:ring-3 focus:ring-brand-primary/20"
      }`}
    />
  );
};

/** Accept / Reject for one sample. The chosen one stays chosen (a reading is replaced, never cleared). */
const DecisionBox = ({ cell, label, disabled, onSave }) => (
  <div role="group" aria-label={label} className="flex gap-1">
    {[
      { value: true, text: "Accept", on: "bg-success-color text-white" },
      { value: false, text: "Reject", on: "bg-error-color text-white" },
    ].map((o) => (
      <button
        key={o.text}
        type="button"
        disabled={disabled}
        aria-pressed={cell?.decision === o.value}
        onClick={() => cell?.decision !== o.value && onSave(o.value)}
        className={`min-h-9.5 min-w-18 rounded-md px-3 text-sm font-medium disabled:opacity-60 ${cell?.decision === o.value ? o.on : "border border-border-color hover:bg-border-color/40"}`}>
        {o.text}
      </button>
    ))}
  </div>
);

/**
 * The run sheet: what to measure next, for each appraiser, trial by trial in the random order the database made (so nobody measures in part order and
 * learns their own earlier answers). Readings save one at a time as they are typed, show at once and go back with a message if refused.
 * "By part" lays the same cells out as a table of parts by trials.
 */
const RunSheet = ({ study, canRecord }) => {
  const record = useRecordMeasurements(study.id);
  const { showToast } = useToast();
  const attribute = study.studyType === "attribute";
  const single = study.appraisers.length === 1 && study.parts.length === 1;
  const [appraiser, setAppraiser] = useState(study.appraisers[0]?.position ?? 1);
  const [view, setView] = useState("order");
  const [pasting, setPasting] = useState(false);
  const cells = useMemo(() => cellMap(study.cells), [study.cells]);
  const partLabel = useMemo(() => Object.fromEntries(study.parts.map((p) => [p.position, p.label])), [study.parts]);
  const trials = useMemo(() => runSheet(study.cells, appraiser), [study.cells, appraiser]);
  const writable = canRecord && study.status === "collecting";

  const save = (c, patch) =>
    record.mutate(
      { cells: [{ appraiser: c.appraiser, part: c.part, trial: c.trial, ...patch }], source: "grid" },
      { onError: (err) => showToast({ type: "error", title: "Reading not saved", message: describeApiError(err) }) }
    );

  const nameOf = (position) => study.appraisers.find((a) => a.position === position)?.name ?? `Appraiser ${position}`;
  const control = (c) => {
    const label = `${nameOf(c.appraiser)}, ${partLabel[c.part] ?? `part ${c.part}`}, trial ${c.trial}`;
    return attribute ? (
      <DecisionBox cell={cells[cellKey(c.appraiser, c.part, c.trial)]} label={label} disabled={!writable} onSave={(decision) => save(c, { decision })} />
    ) : (
      <ReadingBox cell={cells[cellKey(c.appraiser, c.part, c.trial)]} label={label} disabled={!writable} onSave={(value) => save(c, { value })} />
    );
  };

  const filledFor = (a) => study.cells.filter((c) => c.appraiser === a && isFilled(c)).length;
  const totalFor = (a) => study.cells.filter((c) => c.appraiser === a).length;

  return (
    <div className="flex flex-col gap-4" data-sheet="">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {study.appraisers.length > 1 && (
            <SlidingToggle
              ariaLabel="Appraiser"
              mode="tabs"
              value={appraiser}
              onChange={setAppraiser}
              options={study.appraisers.map((a) => ({ value: a.position, label: a.name, count: `${filledFor(a.position)}/${totalFor(a.position)}` }))}
            />
          )}
          {!single && (
            <SlidingToggle
              ariaLabel="Layout of the run sheet"
              value={view}
              onChange={setView}
              options={[
                { value: "order", label: "Run order" },
                { value: "part", label: attribute ? "By sample" : "By part" },
              ]}
            />
          )}
        </div>
        {writable && (
          <CTAButton buttonType="button" type="secondary" size="default" onClick={() => setPasting(true)} title="Paste readings from a spreadsheet or a CSV file">
            Paste readings
          </CTAButton>
        )}
      </div>

      {!canRecord && study.status === "collecting" && <Callout tone="info">You can read this study but not enter readings: that needs permission to record calibrations at the gauge's site.</Callout>}

      {(view === "order" || single) && (
        <div className="flex flex-col gap-5">
          {trials.map(({ trial, cells: list }) => (
            <section key={trial} aria-label={`Trial ${trial}`} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-secondary-text">{single ? "Readings" : `Trial ${trial}`}</h3>
              <ol className={`grid gap-2 ${single ? "sm:grid-cols-2 lg:grid-cols-3" : ""}`}>
                {list.map((c, i) => (
                  <li key={cellKey(c.appraiser, c.part, c.trial)} className="flex items-center justify-between gap-3 rounded-lg border border-border-color px-3 py-1.5">
                    <span className="text-sm">
                      <span className="mr-2 inline-block w-6 text-right tabular-nums text-secondary-text">{single ? c.trial : i + 1}.</span>
                      {single ? "Reading" : partLabel[c.part] ?? `Part ${c.part}`}
                    </span>
                    <div className="w-44 shrink-0">{control(c)}</div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      {view === "part" && !single && (
        <div className="overflow-x-auto rounded-lg border border-border-color">
          <table className="w-full min-w-max border-collapse text-sm">
            <thead>
              <tr className="bg-secondary-bg text-left">
                <th className="px-3 py-2 font-medium">{attribute ? "Sample" : "Part"}</th>
                {trials.map((t) => (
                  <th key={t.trial} className="px-3 py-2 font-medium">
                    Trial {t.trial}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {study.parts.map((p) => (
                <tr key={p.position} className="border-t border-border-color">
                  <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-medium">
                    {p.label}
                  </th>
                  {trials.map((t) => {
                    const c = t.cells.find((x) => x.part === p.position);
                    return (
                      <td key={t.trial} className="px-2 py-1.5">
                        {c ? control(c) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pasting && <PasteDialog study={study} onClose={() => setPasting(false)} />}
    </div>
  );
};

/** Paste a sheet or CSV: the server reads it and says which rows it cannot place; nothing is saved until the person records what it found. */
const PasteDialog = ({ study, onClose }) => {
  const parse = useParsePaste(study.id);
  const record = useRecordMeasurements(study.id);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const result = parse.data;
  const fileRef = useRef(null);
  const attribute = study.studyType === "attribute";

  const check = () => {
    setError("");
    parse.mutate(text, { onError: (e) => setError(describeApiError(e)) });
  };
  const recordAll = () => {
    setError("");
    record.mutate(
      { cells: result.cells.map((c) => ({ appraiser: c.appraiser, part: c.part, trial: c.trial, ...(attribute ? { decision: c.decision } : { value: c.value }) })), source: "paste" },
      { onSuccess: onClose, onError: (e) => setError(describeApiError(e)) }
    );
  };
  const loadFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setText(await file.text());
    parse.reset();
  };

  return (
    <Dialog title="Paste readings" onClose={onClose} width="max-w-3xl">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          {attribute
            ? "Paste rows with a header such as appraiser, part, trial, decision (accept or reject)."
            : study.appraisers.length === 1 && study.parts.length === 1
              ? "Paste a column of readings, one under another, or rows with a header such as trial, value."
              : "Paste rows with a header such as appraiser, part, trial, value. The appraiser and part can be named or numbered; trial can be left out and is then counted in order."}{" "}
          Excel, a CSV file, tabs, semicolons and decimal commas are all read. Nothing is saved until you record what was found.
        </p>
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text">
          Readings
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              parse.reset();
            }}
            rows={9}
            spellCheck={false}
            className="rounded-lg border border-border-color bg-text-input-color px-3 py-2 font-mono text-sm text-primary-text outline-none focus:border-brand-primary focus:ring-3 focus:ring-brand-primary/20"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" className="sr-only" aria-label="Choose a CSV file" onChange={loadFile} />
          <CTAButton buttonType="button" type="neutral" size="md" onClick={() => fileRef.current?.click()}>
            Open a file…
          </CTAButton>
          <CTAButton buttonType="button" type="secondary" size="md" disabled={text.trim() === ""} loading={parse.isPending} onClick={check}>
            Check
          </CTAButton>
        </div>

        {result && (
          <div className="flex flex-col gap-2" aria-live="polite">
            <Callout tone={result.ok ? "success" : result.cells.length > 0 ? "warning" : "error"}>
              {result.ok
                ? `${result.cells.length} ${result.cells.length === 1 ? "reading" : "readings"} found and ready to record.`
                : `${result.cells.length} of ${result.rows} ${result.rows === 1 ? "row" : "rows"} could be placed. Fix the rows below, or record what was found and enter the rest by hand.`}
            </Callout>
            {result.problems.length > 0 && (
              <ul className="max-h-48 overflow-y-auto rounded-lg border border-border-color p-2 text-sm">
                {result.problems.map((p, i) => (
                  <li key={i} className="py-0.5">
                    <span className="font-medium tabular-nums">Line {p.line}:</span> {p.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <Callout tone="error" role="alert">{error}</Callout>}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="button" type="main" size="md" disabled={!result || result.cells.length === 0} loading={record.isPending} onClick={recordAll}>
            {result?.cells.length ? `Record ${result.cells.length} ${result.cells.length === 1 ? "reading" : "readings"}` : "Record"}
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

export default RunSheet;
