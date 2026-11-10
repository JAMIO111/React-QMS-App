import { useId, useRef, useState } from "react";
import { useFormulaCheck, useFormulaFunctions } from "../../hooks/useIntegrations";
import { insertAt, suggestionsFor, tokenAt } from "../../lib/importTemplates";

/**
 * A formula instead of a column: a text box with suggestions for columns ("[" starts one) and functions, the server's reading of the formula under it
 * (its first problem with the position) and the result for the example row. Only the server reads formulas (T3), so the box and the import agree.
 */
const FormulaEditor = ({ value, onChange, columns, sample, label = "Formula", readOnly = false }) => {
  const id = useId();
  const box = useRef(null);
  const [cursor, setCursor] = useState(null);
  const [focused, setFocused] = useState(false);
  const functions = useFormulaFunctions();
  const check = useFormulaCheck(value, columns, sample ?? undefined);
  const token = focused ? tokenAt(value, cursor ?? value.length) : null;
  const suggestions = suggestionsFor(token, columns, functions.data ?? []);
  const result = check.data?.result;
  const error = check.data?.error;

  const choose = (s) => {
    const start = token?.start ?? cursor ?? value.length;
    const end = cursor ?? value.length;
    const cut = value.slice(0, start) + value.slice(end);
    const next = insertAt(cut, start, s.insert);
    onChange(next.formula);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.cursor, next.cursor);
      setCursor(next.cursor);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-secondary-text" data-required>{label}</label>
      <div className="relative">
        <textarea
          id={id}
          ref={box}
          rows={2}
          spellCheck={false}
          value={value}
          maxLength={2000}
          disabled={readOnly}
          placeholder='CONCAT("M-", UPPER([Code]))'
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => { onChange(e.target.value); setCursor(e.target.selectionStart); }}
          onKeyUp={(e) => setCursor(e.currentTarget.selectionStart)}
          onClick={(e) => setCursor(e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          className={`w-full rounded-lg border bg-text-input-color px-3 py-2 font-mono text-sm text-primary-text outline-none ${error ? "border-error-color" : "border-border-color focus:border-brand-primary"}`}
        />
        {suggestions.length > 0 && !readOnly && (
          <ul role="listbox" aria-label="Suggestions" data-popover className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-lg border border-border-color bg-secondary-bg shadow-lg">
            {suggestions.map((s) => (
              <li key={s.insert + s.label} role="option" aria-selected={false}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(s)} className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-border-color">
                  <span className="font-mono text-sm text-primary-text">{s.label}</span>
                  <span className="text-xs text-secondary-text">{s.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div id={`${id}-help`} className="flex flex-col gap-0.5 text-xs" aria-live="polite">
        {!value.trim() ? (
          <span className="text-secondary-text">Columns go in [ ], text in " ". Type a letter for functions, or [ for columns.</span>
        ) : error ? (
          <span className="text-error-color">{error.message}</span>
        ) : result?.error ? (
          <span className="text-error-color">On the example row: {result.error}</span>
        ) : result ? (
          <span className="text-secondary-text">On the example row: <span className="font-mono text-primary-text">{result.value === "" ? "(empty)" : result.value}</span></span>
        ) : check.data?.ok ? (
          <span className="text-success-color">The formula reads correctly</span>
        ) : null}
      </div>
    </div>
  );
};

export default FormulaEditor;
