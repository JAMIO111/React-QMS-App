import { useMemo, useState } from "react";
import { PencilIcon, PlusIcon, SearchIcon } from "@/components/icons";
import Switch from "@/components/ui/Switch";
import { useToast } from "../../contexts/ToastProvider";
import { useNcrMutation } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";
import CTAButton from "@/components/CTAButton";

const inputClass =
  "rounded-lg border border-border-color bg-text-input-color px-3 min-h-9.5 py-1.5 text-sm text-primary-text placeholder:text-tertiary-text focus:outline-none focus:border-brand-primary";

const CodeBadge = ({ children }) => (
  <span className="rounded-md bg-border-color/60 px-1.5 py-0.5 font-mono text-xs text-secondary-text">{children}</span>
);

/** One row: code, name, count of children, status switch (saves at once, reverts on failure) and edit. */
const Row = ({ item, canManage, meta, children }) => {
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [code, setCode] = useState(item.code ?? "");

  const patch = (body, message, done) =>
    mutation.mutate(
      { path: `/ncr-classifications/${item.id}`, method: "PATCH", body },
      {
        onSuccess: () => {
          done?.();
          showToast({ type: "success", title: "Saved", message });
        },
        onError: (error) => showToast({ type: "error", title: "Not saved", message: describeApiError(error) }),
      },
    );

  return (
    <li className="flex flex-col">
      <div className={`group flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 hover:bg-border-color/30 ${item.active ? "" : "opacity-60"}`}>
        {editing ? (
          <form
            className="flex flex-1 flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              patch({ name: name.trim(), code: code.trim() || null }, `${name.trim()} saved.`, () => setEditing(false));
            }}>
            <input aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder="Code" className={`${inputClass} w-24`} />
            <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required className={`${inputClass} w-64 max-w-full`} />
            <CTAButton buttonType="submit" disabled={mutation.isPending} loading={mutation.isPending} type="main" size="md">
              Save
            </CTAButton>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(item.name);
                setCode(item.code ?? "");
              }}
              className="text-sm text-secondary-text hover:underline cursor-pointer">
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-2 text-primary-text">
              {item.code && <CodeBadge>{item.code}</CodeBadge>}
              <span className="truncate">{item.name}</span>
              {meta}
              {!item.active && <span className="rounded-full bg-border-color/60 px-2 py-0.5 text-xs text-secondary-text">Inactive</span>}
            </span>
            {canManage && (
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  aria-label={`Rename ${item.name}`}
                  title="Edit"
                  className="rounded-md p-1.5 text-secondary-text hover:bg-border-color/60 hover:text-primary-text cursor-pointer">
                  <PencilIcon />
                </button>
                <Switch
                  checked={item.active}
                  aria-label={`${item.name} active`}
                  title={item.active ? "Active: tap to deactivate" : "Inactive: tap to reactivate"}
                  onChange={(e) => patch({ active: e.target.checked }, `${item.name} ${e.target.checked ? "reactivated" : "deactivated"}.`)}
                />
              </span>
            )}
          </>
        )}
      </div>
      {children}
    </li>
  );
};

/** Add form for a classification (kind, optional parent). */
const AddForm = ({ kind, parentId, label }) => {
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(
          { path: "/ncr-classifications", body: { kind, name: name.trim(), ...(parentId ? { parentId } : {}), ...(code.trim() ? { code: code.trim() } : {}) } },
          {
            onSuccess: () => {
              setName("");
              setCode("");
            },
            onError: (error) => showToast({ type: "error", title: "Not added", message: describeApiError(error) }),
          },
        );
      }}>
      {!parentId && <input aria-label={`${label} code`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder="Code" className={`${inputClass} w-24`} />}
      <input aria-label={`New ${label.toLowerCase()}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={`Add ${label.toLowerCase()}…`} className={`${inputClass} w-64 max-w-full`} />
      <CTAButton buttonType="submit" disabled={!name.trim() || mutation.isPending} loading={mutation.isPending} type="main" size="md" className="gap-1">
        <PlusIcon /> Add
      </CTAButton>
    </form>
  );
};

/** Failure modes (with their sub-failure modes) or categories, with search and an inactive filter. */
const ClassificationList = ({ kind, lists, canManage }) => {
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const items = kind === "failure_mode" ? lists.failureModes : lists.categories;
  const label = kind === "failure_mode" ? "Failure mode" : "Category";

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (c) => !q || `${c.code ?? ""} ${c.name}`.toLowerCase().includes(q);
    return items
      .map((item) => {
        const subs = kind === "failure_mode" ? lists.subFailureModes.filter((s) => s.parentId === item.id) : [];
        const shownSubs = subs.filter((s) => (showInactive || s.active) && (matches(s) || matches(item)));
        return { item, subs, shownSubs, show: (showInactive || item.active) && (matches(item) || shownSubs.length > 0) };
      })
      .filter((r) => r.show);
  }, [items, lists.subFailureModes, kind, query, showInactive]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary-text" />
          <input
            aria-label={`Search ${label.toLowerCase()}s`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className={`${inputClass} w-64 max-w-full pl-8`}
          />
        </label>
        <Switch className="ml-auto text-sm text-secondary-text" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)}>
          Show inactive
        </Switch>
      </div>
      <div className="rounded-xl border border-border-color">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-secondary-text">{items.length === 0 ? "None yet." : "Nothing matches."}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color/60 p-1">
            {visible.map(({ item, subs, shownSubs }) => (
              <Row
                key={item.id}
                item={item}
                canManage={canManage}
                meta={kind === "failure_mode" && subs.length > 0 && <span className="text-xs text-tertiary-text">{subs.length} sub</span>}>
                {kind === "failure_mode" && (
                  <ul className="mb-2 ml-8 flex flex-col border-l-2 border-border-color pl-2">
                    {shownSubs.map((s) => (
                      <Row key={s.id} item={s} canManage={canManage} />
                    ))}
                    {canManage && item.active && <AddForm kind="sub_failure_mode" parentId={item.id} label="Sub-failure mode" />}
                  </ul>
                )}
              </Row>
            ))}
          </ul>
        )}
      </div>
      {canManage && (
        <div className="rounded-xl border border-dashed border-border-color">
          <AddForm kind={kind} label={label} />
        </div>
      )}
    </div>
  );
};

export default ClassificationList;
