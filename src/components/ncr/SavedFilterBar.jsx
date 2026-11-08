import { useState } from "react";
import { BookmarkPlusIcon, EllipsisIcon, PencilIcon, Trash2Icon } from "@/components/icons";
import CTAButton from "../CTAButton";
import Dialog from "../ui/Dialog";
import DropdownMenu from "../ui/DropdownMenu";
import SlidingToggle from "../ui/SlidingToggle";
import { useSavedFilterMutation, useSavedFilters } from "../../hooks/useSavedFilters";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { SAVED_FILTER_LIMIT, cleanFilters, describeFilter, hasFilters, sameFilters, toFilterValues } from "../../lib/savedFilters";
import { sourceLabel, stageOf } from "../../lib/ncr";

/**
 * Asks for the name of a filter being saved (`rename` false) or renamed. Saving under the name of another filter replaces that filter's contents; renaming to
 * the name of another filter is refused. `blocked` is true when the person already has the most they may keep.
 */
const NameDialog = ({ title, saveText, initial = "", summary = [], existing = [], rename = false, blocked = false, pending, onSave, onClose }) => {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  const same = existing.find((f) => f.name.toLowerCase() === trimmed.toLowerCase());
  const refusedName = rename && !!same;
  const full = !rename && blocked && !same;
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !full && !refusedName) onSave(trimmed, rename ? undefined : same);
        }}
        className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text">
          <span data-required>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            aria-required="true"
            placeholder="e.g. Open majors"
            className="h-9.5 rounded-lg border border-border-color bg-text-input-color px-3 text-sm font-normal text-primary-text focus:outline-none focus:border-brand-primary"
          />
        </label>
        {!rename && summary.length > 0 && (
          <p className="text-sm text-secondary-text">
            <span className="font-medium">Saves:</span> {summary.join(" · ")}
          </p>
        )}
        {!rename && same && <p className="text-sm text-warning-color">You already have a filter called “{same.name}”. Saving replaces it.</p>}
        {refusedName && (
          <p role="alert" className="text-sm text-error-color">
            You already have a filter called “{same.name}”.
          </p>
        )}
        {full && (
          <p role="alert" className="text-sm text-error-color">
            You have {SAVED_FILTER_LIMIT} saved filters. Delete one to save another, or use the name of one to replace it.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!trimmed || full || refusedName || pending}>
            {pending ? "Saving…" : !rename && same ? "Replace" : saveText}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const labelFor = (key, value) => (key === "source" ? sourceLabel(value) : key === "stage" ? stageOf(value).label : null);

/** Every saved filter by name with what it contains; each row's "…" renames or deletes it. */
const ManageDialog = ({ saved, onRename, onDelete, onClose }) => (
  <Dialog title="Saved filters" onClose={onClose} width="max-w-2xl">
    {saved.length === 0 ? (
      <p className="text-sm text-secondary-text">You have no saved filters.</p>
    ) : (
      <ul className="flex flex-col divide-y divide-border-color">
        {saved.map((f) => {
          const rows = describeFilter(f.filters, labelFor);
          return (
            <li key={f.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-primary-text truncate">{f.name}</p>
                {rows.length === 0 ? (
                  <p className="text-sm text-secondary-text">No filters</p>
                ) : (
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {rows.map((r) => (
                      <li key={r.key} className="rounded-full border border-border-color bg-secondary-bg px-2 py-0.5 text-xs text-secondary-text">
                        <span className="font-medium">{r.title}:</span> {r.value}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <DropdownMenu
                label={`Actions for ${f.name}`}
                width={192}
                items={[
                  { label: "Rename", icon: PencilIcon, onSelect: () => onRename(f) },
                  { label: "Delete", icon: Trash2Icon, tone: "danger", onSelect: () => onDelete(f) },
                ]}
                trigger={(props) => (
                  <button {...props} aria-label={`Actions for ${f.name}`} className="shrink-0 rounded-lg p-1.5 text-secondary-text hover:text-brand-primary cursor-pointer active:scale-97 transition-transform">
                    <EllipsisIcon size={18} />
                  </button>
                )}
              />
            </li>
          );
        })}
      </ul>
    )}
    <div className="mt-3 flex justify-end">
      <CTAButton type="neutral" size="md" onClick={onClose}>
        Close
      </CTAButton>
    </div>
  </Dialog>
);

/**
 * The bar above a register: "All" and the person's own saved filters (up to five), each one click to apply. A filter chosen in the filter pane that is not saved
 * yet gets a "Save filter" button that asks for a name; a "…" menu renames or deletes the saved ones. `values` are the register's current filters, `keys` the names of
 * all its filters, `summary` the chips' text for the save dialog.
 */
const SavedFilterBar = ({ scope, keys, values, summary = [], onApply, onClearAll }) => {
  const { data } = useSavedFilters(scope);
  const mutation = useSavedFilterMutation(scope);
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null); // { mode: "save" } | { mode: "manage" } | { mode: "rename", filter, from? }
  const saved = data?.data ?? [];
  const limit = data?.limit ?? SAVED_FILTER_LIMIT;
  const any = hasFilters(values, keys);
  const active = any ? saved.find((f) => sameFilters(f.filters, values, keys)) : null;

  const fail = (title) => (error) => showToast({ type: "error", title, message: describeApiError(error) });
  const run = (vars, { onSuccess, errorTitle }) => {
    mutation.mutate(vars, { onSuccess, onError: fail(errorTitle) });
  };

  const save = (name, replacing) => {
    const filters = cleanFilters(values, keys);
    setDialog(null);
    if (replacing) run({ action: "update", id: replacing.id, body: { filters } }, { errorTitle: "Not saved", onSuccess: () => showToast({ type: "success", title: "Filter saved", message: `“${replacing.name}” now shows what you have chosen.` }) });
    else run({ action: "create", body: { name, filters } }, { errorTitle: "Not saved", onSuccess: () => showToast({ type: "success", title: "Filter saved", message: `“${name}” is saved.` }) });
  };
  const rename = (filter, name) => {
    setDialog({ mode: "manage" });
    run({ action: "update", id: filter.id, body: { name } }, { errorTitle: "Not renamed" });
  };
  const remove = (filter) => run({ action: "delete", id: filter.id }, { errorTitle: "Not deleted", onSuccess: () => showToast({ type: "success", title: "Filter deleted", message: `“${filter.name}” is gone.` }) });

  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <SlidingToggle
        ariaLabel="Saved filters"
        mode="tabs"
        options={[{ value: "all", label: "All" }, ...saved.map((f) => ({ value: f.id, label: f.name }))]}
        value={active ? active.id : any ? undefined : "all"}
        onChange={(v) => (v === "all" ? onClearAll() : onApply(toFilterValues(saved.find((f) => f.id === v), keys), saved.find((f) => f.id === v)))}
      />
      {any && !active && (
        <CTAButton type="secondary" size="default" icon={BookmarkPlusIcon} iconSize="h-4 w-4" title={saved.length >= limit ? `You have ${limit} saved filters; use a name to replace one` : "Save the filters you have chosen under a name"} onClick={() => setDialog({ mode: "save" })}>
          Save filter
        </CTAButton>
      )}
      {saved.length > 0 && (
        <button type="button" aria-label="Manage saved filters" title="See, rename or delete your saved filters" onClick={() => setDialog({ mode: "manage" })} className="rounded-lg p-1.5 text-secondary-text hover:text-brand-primary cursor-pointer active:scale-97 transition-transform">
          <EllipsisIcon size={18} />
        </button>
      )}
      {dialog?.mode === "manage" && (
        <ManageDialog saved={saved} onClose={() => setDialog(null)} onRename={(f) => setDialog({ mode: "rename", filter: f })} onDelete={remove} />
      )}
      {dialog?.mode === "save" && (
        <NameDialog title="Save filter" saveText="Save" summary={summary} existing={saved} blocked={saved.length >= limit} pending={mutation.isPending} onSave={save} onClose={() => setDialog(null)} />
      )}
      {dialog?.mode === "rename" && (
        <NameDialog title="Rename filter" saveText="Rename" rename initial={dialog.filter.name} existing={saved.filter((f) => f.id !== dialog.filter.id)} pending={mutation.isPending} onSave={(name) => rename(dialog.filter, name)} onClose={() => setDialog({ mode: "manage" })} />
      )}
    </div>
  );
};

export default SavedFilterBar;
