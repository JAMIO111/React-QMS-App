import { useState } from "react";
import Dialog from "../ui/Dialog";
import { NC_SOURCES } from "../../lib/ncr";

/**
 * "New NC" asks where the problem came from first (the source), because it decides which party fields the form shows; the category
 * (what the problem is) is chosen on the form itself. The source can still be changed later, with a reason.
 */
const NewNcDialog = ({ initial = "internal", onChoose, onClose }) => {
  const [source, setSource] = useState(initial);
  return (
    <Dialog title="Where did this non-conformance come from?" onClose={onClose} width="max-w-2xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onChoose(source);
        }}
        className="flex flex-col gap-4">
        <fieldset>
          <legend className="sr-only">Source</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {NC_SOURCES.map((s) => (
              <label
                key={s.key}
                className={`flex cursor-pointer flex-col rounded-xl border px-3 py-2 ${source === s.key ? "border-brand-primary bg-brand-primary/10" : "border-border-color hover:bg-border-color/30"}`}>
                <input type="radio" name="source" value={s.key} checked={source === s.key} onChange={() => setSource(s.key)} className="sr-only" />
                <span className="font-medium text-primary-text">{s.label}</span>
                <span className="text-xs text-secondary-text">{s.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
            Cancel
          </button>
          <button type="submit" className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover cursor-pointer">
            Continue
          </button>
        </div>
      </form>
    </Dialog>
  );
};

export default NewNcDialog;
