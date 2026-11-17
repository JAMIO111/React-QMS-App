import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Dialog from "@/components/ui/Dialog";
import SlidingToggle from "@/components/ui/SlidingToggle";
import CopyButton from "@/components/ui/CopyButton";
import CTAButton from "@/components/CTAButton";
import { useToast } from "../../contexts/ToastProvider";
import { EDIT_MERGED_EVENT, describeValue, fieldLabel, isDoc, listWords, nameOf, setConflictResolver } from "../../lib/editConflicts";

/**
 * Edit conflicts on screen (docs/edit-conflicts-plan.md EC3). EditConflictHost sits once inside the app's providers: it answers the save layer
 * (lib/editConflicts.js) when a field someone else also changed needs a choice, and turns "both changes kept" into a note.
 */

/** Finds a name for an id among everything the screen has already loaded (pickers, lists), so "your choice" can be shown in words. */
const nameFromCache = (queryClient, id) => {
  let found = null;
  const walk = (node, depth) => {
    if (found || depth > 8 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node.id === id) {
      found = nameOf(node);
      if (found) return;
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  for (const query of queryClient?.getQueryCache().getAll() ?? []) {
    walk(query.state.data, 0);
    if (found) break;
  }
  return found;
};

/** A custom field's own label ("values.batch_ref" → "Batch reference"), from the field definitions already loaded on screen; else the field in words. */
const labelFromCache = (queryClient, field) => {
  const key = String(field).split(".").pop();
  if (!String(field).includes(".")) return fieldLabel(field);
  for (const query of queryClient?.getQueryCache().getAll() ?? []) {
    const list = Array.isArray(query.state.data) ? query.state.data : query.state.data?.data;
    if (!Array.isArray(list)) continue;
    const def = list.find((d) => d && typeof d === "object" && d.key === key && typeof d.label === "string");
    if (def) return def.label;
  }
  return fieldLabel(field);
};

const when = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const EditConflictDialog = ({ request, onDone }) => {
  const queryClient = useQueryClient();
  const [keep, setKeep] = useState(() => Object.fromEntries(request.clashes.map((c) => [c.field, "mine"])));
  const lookup = (id) => nameFromCache(queryClient, id);
  const who = request.changedBy?.name ?? request.people?.[0]?.name ?? "Someone else";
  const at = when(request.changedAt);

  return (
    <Dialog title="Changed while you were editing" onClose={() => onDone(null)} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-secondary-text">
          {who} saved this{at ? ` at ${at}` : ""}, and changed {request.clashes.length === 1 ? "a field" : "fields"} you changed too. Choose what to keep. Your other
          changes are saved as well.
        </p>
        {request.clashes.map((c) => {
          const rich = isDoc(c.mine) || isDoc(c.theirs);
          const mine = describeValue(c.mine, lookup);
          const theirs = describeValue(c.theirs, lookup);
          return (
            <section key={c.field} className="flex flex-col gap-2 rounded-xl border border-border-color p-3" aria-label={labelFromCache(queryClient, c.field)}>
              <h3 className="text-sm font-semibold text-primary-text">{labelFromCache(queryClient, c.field)}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-semibold uppercase text-secondary-text">Theirs</span>
                  <p className={`whitespace-pre-wrap break-words text-sm text-primary-text ${rich ? "max-h-40 overflow-y-auto" : ""}`} data-testid={`theirs-${c.field}`}>
                    {theirs}
                  </p>
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-semibold uppercase text-secondary-text">Yours</span>
                  <p className={`whitespace-pre-wrap break-words text-sm text-primary-text ${rich ? "max-h-40 overflow-y-auto" : ""}`} data-testid={`mine-${c.field}`}>
                    {mine}
                  </p>
                </div>
              </div>
              {rich && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-secondary-text">
                  <span>Text cannot be merged. If you take theirs, copy yours first to paste back what you need.</span>
                  <CopyButton text={mine} label={`Copy your ${labelFromCache(queryClient, c.field).toLowerCase()}`} />
                </div>
              )}
              <SlidingToggle
                ariaLabel={`What to keep for ${labelFromCache(queryClient, c.field)}`}
                mode="radio"
                value={keep[c.field]}
                onChange={(v) => setKeep((k) => ({ ...k, [c.field]: v }))}
                options={[
                  { value: "mine", label: rich ? "Overwrite with mine" : "Keep yours" },
                  { value: "theirs", label: rich ? "Load theirs" : "Take theirs" },
                ]}
              />
            </section>
          );
        })}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={() => onDone(null)}>
            Cancel
          </CTAButton>
          <CTAButton type="main" size="md" onClick={() => onDone({ keepMine: Object.keys(keep).filter((f) => keep[f] === "mine") })}>
            Save
          </CTAButton>
        </div>
      </div>
    </Dialog>
  );
};

/** Once, inside QueryClientProvider and ToastProvider. */
const EditConflictHost = () => {
  const { showToast } = useToast() ?? {};
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(null);

  useEffect(
    () =>
      setConflictResolver(
        (request) =>
          new Promise((resolve) => {
            setPending({ request, resolve });
          }),
      ),
    [],
  );

  useEffect(() => {
    const onMerged = (event) => {
      const { people = [], fields = [], kept } = event.detail ?? {};
      const names = listWords([...new Set(people.map((p) => p.name).filter(Boolean))]) || "Someone else";
      const what = fields.length ? listWords([...new Set(fields.map((f) => labelFromCache(queryClient, f)))]) : "this";
      const message =
        kept === "theirs"
          ? `${names} changed ${what}; their values were kept.`
          : kept === "mine"
            ? `${names} also changed ${what}; your choices were saved.`
            : `${names} also changed ${what}; both changes kept.`;
      showToast?.({ type: "info", title: "Saved alongside another change", message });
    };
    window.addEventListener(EDIT_MERGED_EVENT, onMerged);
    return () => window.removeEventListener(EDIT_MERGED_EVENT, onMerged);
  }, [showToast, queryClient]);

  if (!pending) return null;
  return (
    <EditConflictDialog
      request={pending.request}
      onDone={(choice) => {
        pending.resolve(choice);
        setPending(null);
      }}
    />
  );
};

export default EditConflictHost;
