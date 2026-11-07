import { useState } from "react";
import { FactoryIcon, HouseIcon } from "@/components/icons";
import Switch from "@/components/ui/Switch";
import { useToast } from "../../contexts/ToastProvider";
import { useMasterDataMutation } from "../../hooks/useMasterData";
import { useAllDepartments, useSites } from "../../hooks/useQmsApi";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import { FormError } from "./shared";

/**
 * Add or edit an employee in a pop-up. A department belongs to one site: choosing a department fills in its site, and
 * choosing another site clears a department that is not there. Nobody is deleted: edit and untick Active instead. `readOnly` shows the details without saving.
 */
const EmployeeDialog = ({ employee, onClose, readOnly = false }) => {
  const creating = !employee;
  const mutation = useMasterDataMutation();
  const { showToast } = useToast();
  const { data: sites } = useSites({ includeInactive: true });
  const { data: departments } = useAllDepartments({ includeInactive: true });
  const [form, setForm] = useState({
    firstName: employee?.firstName ?? "",
    surname: employee?.surname ?? "",
    jobTitle: employee?.jobTitle ?? "",
    employeeNumber: employee?.employeeNumber ?? "",
    email: employee?.email ?? "",
    siteId: employee?.site?.id ?? null,
    departmentId: employee?.department?.id ?? null,
    active: employee?.active ?? true,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const allDepartments = departments?.data ?? [];
  const departmentOptions = allDepartments
    .filter((d) => !form.siteId || d.siteId === form.siteId)
    .map((d) => ({ id: d.id, name: `${d.code} · ${d.name}`, hint: form.siteId ? undefined : (sites?.data ?? []).find((s) => s.id === d.siteId)?.name }));

  const chooseSite = (siteId) =>
    setForm((f) => ({ ...f, siteId, departmentId: siteId && allDepartments.find((d) => d.id === f.departmentId)?.siteId !== siteId ? null : f.departmentId }));
  const chooseDepartment = (departmentId) =>
    setForm((f) => ({ ...f, departmentId, siteId: departmentId ? (allDepartments.find((d) => d.id === departmentId)?.siteId ?? f.siteId) : f.siteId }));

  const submit = (e) => {
    e.preventDefault();
    const body = {
      firstName: form.firstName.trim(),
      surname: form.surname.trim(),
      jobTitle: form.jobTitle.trim() || null,
      employeeNumber: form.employeeNumber.trim() || null,
      email: form.email.trim() || null,
      siteId: form.siteId,
      departmentId: form.departmentId,
      ...(creating ? {} : { active: form.active }),
    };
    mutation.mutate(
      { path: creating ? "/employees" : `/employees/${employee.id}`, method: creating ? "POST" : "PATCH", body },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Saved", message: `${body.firstName} ${body.surname} ${creating ? "added" : "updated"}.` });
          onClose();
        },
      }
    );
  };

  return (
    <Dialog title={creating ? "New employee" : readOnly ? employee.name : `Edit ${employee.name}`} onClose={onClose} width="max-w-2xl">
      <form onSubmit={submit} className="flex flex-col gap-4" aria-label={creating ? "New employee" : "Edit employee"}>
        <fieldset disabled={readOnly} className="contents">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First name" value={form.firstName} onChange={set("firstName")} required maxLength={100} />
          <Field label="Surname" value={form.surname} onChange={set("surname")} required maxLength={100} />
          <Field label="Job title" value={form.jobTitle} onChange={set("jobTitle")} maxLength={100} />
          <Field label="Employee number" value={form.employeeNumber} onChange={set("employeeNumber")} maxLength={40} hint="Unique in the organisation, e.g. E-0042" />
          <Field label="Work email" type="email" value={form.email} onChange={set("email")} maxLength={200} className="sm:col-span-2" />
          <RHFComboBox
            label="Site"
            icon={HouseIcon}
            placeholder="No site"
            options={(sites?.data ?? []).map((s) => ({ id: s.id, name: `${s.code} · ${s.name}` }))}
            value={form.siteId}
            onChange={chooseSite}
          />
          <RHFComboBox label="Department" icon={FactoryIcon} placeholder="No department" options={departmentOptions} value={form.departmentId} onChange={chooseDepartment} />
        </div>
        </fieldset>
        {!creating && (
          <Switch className="text-sm text-primary-text" disabled={readOnly} checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}>
            Active (inactive people are kept, and stay on past records, but are not offered for new ones)
          </Switch>
        )}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-btn-border bg-neutral-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-neutral-btn-bg-hover cursor-pointer">
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
          <button
            type="submit"
            disabled={mutation.isPending || form.firstName.trim().length === 0 || form.surname.trim().length === 0}
            className="rounded-lg border border-cta-btn-border bg-cta-btn-bg px-3 py-1.5 text-sm text-primary-text hover:bg-cta-btn-bg-hover disabled:opacity-50 cursor-pointer">
            {mutation.isPending ? "Saving…" : creating ? "Add employee" : "Save changes"}
          </button>
          )}
        </div>
      </form>
    </Dialog>
  );
};

export default EmployeeDialog;
