import { useState } from "react";
import { PlusIcon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { useNcrMutation } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";

const inputClass = "rounded-lg border border-border-color bg-text-input-color px-2 py-1 text-sm text-primary-text focus:outline-none focus:border-brand-primary";

/** One editable row: code, name, active. */
const Row = ({ item, canManage, children }) => {
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [code, setCode] = useState(item.code ?? "");

  const patch = (body, message) =>
    mutation.mutate(
      { path: `/ncr-classifications/${item.id}`, method: "PATCH", body },
      {
        onSuccess: () => {
          setEditing(false);
          showToast({ type: "success", title: "Saved", message });
        },
        onError: (error) => showToast({ type: "error", title: "Not saved", message: describeApiError(error) }),
      }
    );

  return (
    <li className={`flex flex-col gap-1 rounded-lg px-2 py-1 ${item.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              patch({ name: name.trim(), code: code.trim() || null }, `${name.trim()} saved.`);
            }}>
            <input aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder="Code" className={`${inputClass} w-24`} />
            <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required className={`${inputClass} w-56`} />
            <button type="submit" disabled={mutation.isPending} className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-2 py-1 text-sm cursor-pointer">Save</button>
            <button type="button" onClick={() => setEditing(false)} className="text-sm text-secondary-text hover:underline cursor-pointer">Cancel</button>
          </form>
        ) : (
          <>
            <span className="text-primary-text">
              {item.code && <span className="mr-2 font-mono text-secondary-text">{item.code}</span>}
              {item.name}
              {!item.active && <span className="ml-2 text-xs text-secondary-text">(inactive)</span>}
            </span>
            {canManage && (
              <span className="ml-auto flex gap-2 text-sm">
                <button type="button" onClick={() => setEditing(true)} className="text-link-color hover:underline cursor-pointer" aria-label={`Rename ${item.name}`}>
                  Edit
                </button>
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => patch({ active: !item.active }, `${item.name} ${item.active ? "deactivated" : "reactivated"}.`)}
                  className="text-link-color hover:underline cursor-pointer"
                  aria-label={`${item.active ? "Deactivate" : "Reactivate"} ${item.name}`}>
                  {item.active ? "Deactivate" : "Reactivate"}
                </button>
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
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-2 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(
          { path: "/ncr-classifications", body: { kind, name: name.trim(), ...(parentId ? { parentId } : {}), ...(code.trim() ? { code: code.trim() } : {}) } },
          {
            onSuccess: () => {
              setName("");
              setCode("");
            },
          }
        );
      }}>
      {!parentId && <input aria-label={`${label} code`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder="Code" className={`${inputClass} w-24`} />}
      <input aria-label={`New ${label.toLowerCase()}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={`Add ${label.toLowerCase()}…`} className={`${inputClass} w-56`} />
      <button type="submit" disabled={!name.trim() || mutation.isPending} className="flex items-center gap-1 rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-2 py-1 text-sm disabled:opacity-50 cursor-pointer">
        <PlusIcon className="h-4 w-4" /> Add
      </button>
      {mutation.error && (
        <span role="alert" className="text-sm text-error-color">
          {describeApiError(mutation.error)}
        </span>
      )}
    </form>
  );
};

/** Failure modes (with their sub-failure modes) or processes. */
const ClassificationList = ({ kind, lists, canManage }) => {
  const items = kind === "failure_mode" ? lists.failureModes : lists.processes;
  const label = kind === "failure_mode" ? "Failure mode" : "Process";
  return (
    <div className="flex flex-col gap-2 py-2">
      {items.length === 0 && <p className="px-2 text-sm text-secondary-text">None yet.</p>}
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <Row key={item.id} item={item} canManage={canManage}>
            {kind === "failure_mode" && (
              <ul className="ml-6 flex flex-col gap-1 border-l border-border-color pl-2">
                {lists.subFailureModes
                  .filter((s) => s.parentId === item.id)
                  .map((s) => (
                    <Row key={s.id} item={s} canManage={canManage} />
                  ))}
                {canManage && item.active && <AddForm kind="sub_failure_mode" parentId={item.id} label="Sub-failure mode" />}
              </ul>
            )}
          </Row>
        ))}
      </ul>
      {canManage && <AddForm kind={kind} label={label} />}
    </div>
  );
};

export default ClassificationList;
