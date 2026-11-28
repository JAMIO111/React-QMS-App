import { useMemo, useState } from "react";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import ComboField from "../ui/ComboField";
import RowActionsMenu from "../ui/RowActionsMenu";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import { PlusIcon } from "@/components/icons";
import { usePermissionList, usePermissions, useRoleMutation, useRoles } from "../../hooks/useQmsApi";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { useToast } from "../../contexts/ToastProvider";
import { describeApiError } from "../../lib/api-client";
import { NOT_IN_CUSTOM_ROLES, SEAT_WORDS, groupPermissions, groupState, highestSeat, holdersWords, roleProblems, viewOnly } from "../../lib/roles";

const Pill = ({ children, tone = "neutral" }) => (
  <span
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
      tone === "info" ? "bg-brand-primary/15 text-brand-primary" : "bg-secondary-bg text-secondary-text ring-1 ring-border-color"
    }`}>
    {children}
  </span>
);

/**
 * Settings → Roles (docs/custom-roles-plan.md): the Owner makes their own roles by choosing what each can do. Built-in roles stay as they are (a
 * copy starts a new one). The database decides what a role may carry and refuses what is not allowed; this page says so in words.
 */
const SettingsRoles = () => {
  const { can, isLoading } = usePermissions();
  if (isLoading) return <LoadingScreen />;
  if (!can("roles.manage")) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Callout tone="info" title="Roles">
          Only the organisation&apos;s owners can make or change roles.
        </Callout>
      </div>
    );
  }
  return <Page />;
};

export default SettingsRoles;

function Page() {
  const roles = useRoles();
  const permissions = usePermissionList();
  const mutate = useRoleMutation();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [editing, setEditing] = useState(null); // { role } to change, { start } to make a new one (start = a role to copy, or null)

  const list = roles.data?.data ?? [];
  const custom = list.filter((r) => !r.isSystem);
  const builtIn = list.filter((r) => r.isSystem);

  if (roles.isLoading || permissions.isLoading) return <LoadingScreen />;
  if (roles.error || permissions.error) {
    return (
      <div className="p-4">
        <Callout tone="error" role="alert" title="Roles could not be loaded">
          {describeApiError(roles.error ?? permissions.error)}
        </Callout>
      </div>
    );
  }

  const remove = async (role) => {
    const ok = await confirm({
      title: `Delete the ${role.name} role?`,
      message: "Nobody holds it, so no one loses access. This cannot be undone.",
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "warning",
    });
    if (!ok) return;
    try {
      await mutate.mutateAsync({ action: "delete", roleId: role.id });
    } catch (error) {
      showToast({ type: "error", title: "The role was not deleted", message: describeApiError(error) });
    }
  };

  const rowMenu = (role) => [
    !role.isSystem && { label: "Edit", onSelect: () => setEditing({ role }) },
    { label: "Make a copy", onSelect: () => setEditing({ start: role }) },
    !role.isSystem && {
      label: role.holders > 0 ? `Delete (${holdersWords(role.holders).toLowerCase()})` : "Delete",
      tone: "danger",
      disabled: role.holders > 0,
      onSelect: () => remove(role),
    },
  ];

  const renderRow = (role) => (
    <li key={role.id} className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium text-primary-text">
          {role.name}
          {role.isSystem ? <Pill>Built in</Pill> : <Pill tone="info">Custom</Pill>}
        </p>
        {role.description && <p className="text-sm text-secondary-text">{role.description}</p>}
        <p className="text-xs text-tertiary-text">
          {role.permissions.length} {role.permissions.length === 1 ? "permission" : "permissions"} · {holdersWords(role.holders)}
        </p>
      </div>
      <RowActionsMenu label={`Actions for ${role.name}`} items={rowMenu(role)} />
    </li>
  );

  return (
    <div className="flex w-full flex-col gap-5">
      <div>
        <h2 className="text-2xl font-semibold text-primary-text">Roles</h2>
        <p className="text-sm text-secondary-text">
          Make your own roles by choosing exactly what each one can do, then give them to people under Users &amp; permissions. The built-in roles stay as they are; make a copy to start from one.
        </p>
      </div>

      <Callout tone="info" title="A role never gives more than a seat allows">
        What a person can do is the role <em>and</em> their seat together. A role that includes actions beyond a Contributor seat has no effect on someone with only that seat. Each permission below shows the seat it needs.
      </Callout>

      <MenuCard
        title="Your roles"
        subtitle="Roles you made"
        action={
          <CTAButton type="main" icon={PlusIcon} onClick={() => setEditing({ start: null })}>
            New role
          </CTAButton>
        }>
        {custom.length === 0 ? (
          <p className="text-sm text-secondary-text">
            You have not made a role yet. Choose <strong>New role</strong>, or make a copy of a built-in role below and change it.
          </p>
        ) : (
          <ul className="divide-y divide-border-color">
            {custom.map(renderRow)}
          </ul>
        )}
      </MenuCard>

      <MenuCard title="Built-in roles" subtitle="These cannot be changed">
        <ul className="divide-y divide-border-color">
          {builtIn.map(renderRow)}
        </ul>
      </MenuCard>

      {editing && <RoleDialog {...editing} roles={list} permissions={permissions.data?.data ?? []} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoleDialog({ role = null, start = null, roles, permissions, onClose }) {
  const mutate = useRoleMutation();
  const rolesQuery = useRoles();
  const source = role ?? start;
  const [name, setName] = useState(role ? role.name : start ? `${start.name} copy` : "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [selected, setSelected] = useState(() => new Set((source?.permissions ?? []).filter((c) => !NOT_IN_CUSTOM_ROLES.includes(c))));
  const [startId, setStartId] = useState(start?.id ?? "");
  const [error, setError] = useState(null);

  const groups = useMemo(() => groupPermissions(permissions), [permissions]);
  const problems = roleProblems({ name, selected });
  const seat = highestSeat(permissions, selected);
  const editingRole = !!role;

  const change = (codes, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of codes) (on ? next.add(c) : next.delete(c));
      return next;
    });
  const chooseStart = (id) => {
    setStartId(id);
    const from = roles.find((r) => r.id === id);
    setSelected(new Set((from?.permissions ?? []).filter((c) => !NOT_IN_CUSTOM_ROLES.includes(c))));
    if (from && !name.trim()) setName(`${from.name} copy`);
  };

  const save = async (event) => {
    event.preventDefault();
    setError(null);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    const body = { name: name.trim(), description: description.trim() || null, permissions: [...selected] };
    try {
      if (editingRole) {
        // Roles keep their permissions in another table, so the check that nobody else changed it since this window opened is made here, on the
        // freshest copy, rather than by the shared field-by-field merge (which could not see a change to the permissions).
        const fresh = (await rolesQuery.refetch()).data?.data?.find((r) => r.id === role.id);
        if (!fresh) throw new Error("This role no longer exists.");
        if (fresh.rowVersion !== role.rowVersion) {
          throw new Error("Someone else changed this role since you opened it. Close this window and open the role again to see their changes.");
        }
        await mutate.mutateAsync({ action: "update", roleId: role.id, body });
      } else {
        await mutate.mutateAsync({ action: "create", body });
      }
      onClose();
    } catch (e) {
      setError(describeApiError(e));
    }
  };

  return (
    <Dialog title={editingRole ? `Change ${role.name}` : start ? `Copy of ${start.name}` : "New role"} onClose={onClose} width="max-w-3xl">
      <form onSubmit={save} noValidate className="flex flex-col gap-4">
        {editingRole && role.holders > 0 && (
          <Callout tone="warning" role="status">
            {holdersWords(role.holders)}. What you change here takes effect for {role.holders === 1 ? "them" : "all of them"} as soon as you save.
          </Callout>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          {!editingRole && (
            <ComboField
              label="Start from"
              value={startId}
              onChange={chooseStart}
              placeholder="A blank role"
              options={roles.map((r) => ({ value: r.id, label: r.name, hint: r.isSystem ? "Built in" : "Custom" }))}
            />
          )}
        </div>
        <TextAreaField label="What it is for" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />

        <div className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-primary-text" data-required>
                What this role can do
              </h3>
              <p className="text-xs text-tertiary-text">
                {selected.size} {selected.size === 1 ? "permission" : "permissions"} chosen
                {seat ? ` · needs at least a ${SEAT_WORDS[seat]} seat for the most it includes` : ""}
              </p>
            </div>
          </div>
          {groups.map((g) => {
            const state = groupState(g, selected);
            const read = viewOnly(g);
            return (
              <fieldset key={g.module} className="rounded-xl border border-border-color p-3">
                <legend className="flex items-center gap-3 px-1 text-sm font-semibold text-primary-text">
                  {g.module}
                  <span className="flex gap-2 text-xs font-normal">
                    <button type="button" className="text-brand-primary underline" onClick={() => change(g.items.map((p) => p.code), true)} aria-label={`Choose all of ${g.module}`}>
                      All
                    </button>
                    {read.length > 0 && read.length < g.items.length && (
                      <button
                        type="button"
                        className="text-brand-primary underline"
                        onClick={() => {
                          change(g.items.map((p) => p.code), false);
                          change(read.map((p) => p.code), true);
                        }}
                        aria-label={`Choose only the viewing permissions of ${g.module}`}>
                        View only
                      </button>
                    )}
                    {state !== "none" && (
                      <button type="button" className="text-brand-primary underline" onClick={() => change(g.items.map((p) => p.code), false)} aria-label={`Clear ${g.module}`}>
                        None
                      </button>
                    )}
                  </span>
                </legend>
                {g.module === "Administration" && (
                  <p className="mb-2 text-xs text-tertiary-text">These let a person run the organisation itself (people, security, billing). Give them carefully. Managing roles stays with the Owner role.</p>
                )}
                <ul className="grid gap-1 sm:grid-cols-2">
                  {g.items.map((p) => (
                    <li key={p.code}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg p-1.5 text-sm hover:bg-primary-bg">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={selected.has(p.code)}
                          onChange={(e) => change([p.code], e.target.checked)}
                        />
                        <span className="min-w-0">
                          <span className="text-primary-text">{p.description}</span>{" "}
                          {p.needs && <span className="text-xs text-tertiary-text">({SEAT_WORDS[p.needs]} seat)</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            );
          })}
        </div>

        {error && (
          <p role="alert" className="text-sm text-error-color">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <CTAButton type="neutral" size="md" onClick={onClose}>
            Cancel
          </CTAButton>
          <CTAButton type="main" size="md" buttonType="submit" loading={mutate.isPending}>
            {editingRole ? "Save changes" : "Make the role"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
}
