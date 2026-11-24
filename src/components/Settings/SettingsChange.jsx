import { useState } from "react";
import { PencilIcon, PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useChangeAreas, useChangeFunctions, useChangeMutation, useChangeTypes } from "../../hooks/useChange";
import { usePermissions } from "../../hooks/useQmsApi";
import { ErrorNotice, FormError } from "../master-data/shared";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";

/** Add or rename a type (with whether it usually needs the customer) or a function. */
const ListDialog = ({ kind, existing, onClose }) => {
  const mutation = useChangeMutation();
  const { showToast } = useToast();
  const isType = kind === "type";
  const noun = isType ? "type" : "function";
  const [label, setLabel] = useState(existing?.label ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [customer, setCustomer] = useState(existing?.needsCustomerApproval ?? false);
  const save = (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    const body = { label: label.trim(), description: description.trim() || null, ...(isType ? { needsCustomerApproval: customer } : {}) };
    const action = `${existing ? "update" : "create"}${isType ? "Type" : "Function"}`;
    // A rename shows at once (a refusal is told by the hook); a new entry waits for the server.
    if (existing) {
      mutation.mutate({ action, id: existing.id, body });
      onClose();
      return;
    }
    mutation.mutate({ action, body }, { onSuccess: onClose, onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }) });
  };
  return (
    <Dialog title={existing ? `Edit ${existing.label}` : `Add a ${noun}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Name" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} placeholder={isType ? "e.g. Packaging" : "e.g. Maintenance"} />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} hint="Optional" />
        {isType && (
          <label className="flex items-center gap-3 text-sm text-primary-text">
            <Switch checked={customer} onChange={() => setCustomer((v) => !v)}>
              <span className="sr-only">Usually needs the customer</span>
            </Switch>
            Usually needs the customer&apos;s approval
          </label>
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton buttonType="submit" type="main" size="md" disabled={!label.trim() || mutation.isPending} loading={mutation.isPending}>
            {existing ? "Save" : `Add ${noun}`}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** One list: entries with an on/off switch (nothing is deleted) and, when `kind` is given, add and edit. */
const ListCard = ({ title, subtitle, query, action, kind, canManage, canAdd, count }) => {
  const mutation = useChangeMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  const toggle = (item) =>
    mutation.mutate(
      { action, id: item.id, body: { active: !item.active } },
      { onError: (err) => showToast({ type: "error", title: "Not changed", message: describeApiError(err) }) },
    );
  return (
    <MenuCard
      title={title}
      subtitle={subtitle}
      action={
        canManage &&
        canAdd && (
          <CTAButton type="main" icon={PlusIcon} onClick={() => setDialog({})}>
            Add {kind}
          </CTAButton>
        )
      }>
      <ul className="-my-3 divide-y divide-border-color" aria-label={title}>
        {query.data.data.map((item) => (
          <li key={item.id} className={`flex flex-wrap items-center justify-between gap-3 py-3 ${item.active ? "" : "opacity-60"}`}>
            <div className="flex min-w-0 flex-col">
              <span className="font-medium text-primary-text">{item.label}</span>
              <span className="text-sm text-secondary-text">
                {[item.needsCustomerApproval ? "Usually needs the customer" : null, count?.(item), item.description].filter(Boolean).join(" · ")}
              </span>
            </div>
            {canManage && (
              <div className="flex items-center gap-3">
                <Switch checked={item.active} onChange={() => toggle(item)}>
                  <span className="sr-only">{item.active ? `Switch ${item.label} off` : `Switch ${item.label} on`}</span>
                </Switch>
                {kind && <CTAButton type="neutral" icon={PencilIcon} aria-label={`Edit ${item.label}`} onClick={() => setDialog({ existing: item })} />}
              </div>
            )}
          </li>
        ))}
      </ul>
      {dialog && <ListDialog kind={kind} existing={dialog.existing} onClose={() => setDialog(null)} />}
    </MenuCard>
  );
};

/** Settings → Data Management → Change: the types of change, the functions that sign them off and the areas a change is assessed for. */
const SettingsChange = () => {
  const { can } = usePermissions();
  const canManage = can("change.manage");
  const types = useChangeTypes({ all: true });
  const functions = useChangeFunctions({ all: true });
  const areas = useChangeAreas({ all: true });
  if (types.isLoading || functions.isLoading || areas.isLoading) return <LoadingScreen />;
  const failed = types.error ?? functions.error ?? areas.error;
  if (failed) return <ErrorNotice error={failed} />;
  return (
    <div className="flex flex-col gap-4">
      <ListCard
        title="Types of change"
        subtitle="What kind of change it is. A type switched off takes no new changes; changes that have it keep it."
        query={types}
        action="updateType"
        kind="type"
        canManage={canManage}
        canAdd
        count={(t) => `${t.changes} ${t.changes === 1 ? "change" : "changes"}`}
      />
      <ListCard
        title="Functions that sign off"
        subtitle="The parts of the business whose agreement a change needs, such as Quality or Production. Who signs for each is set when the board is chosen."
        query={functions}
        action="updateFunction"
        kind="function"
        canManage={canManage}
        canAdd
      />
      <ListCard
        title="Areas a change is assessed for"
        subtitle="The fixed list a change is checked against. An area switched off is no longer asked about."
        query={areas}
        action="updateArea"
        canManage={canManage}
      />
    </div>
  );
};

export default SettingsChange;
