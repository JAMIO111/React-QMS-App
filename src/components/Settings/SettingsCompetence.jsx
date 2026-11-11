import { useMemo, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCompetenceCategories, useCompetenceMutation, useCompetencePositions, useCompetenceSkills } from "../../hooks/useCompetence";
import { groupByCategory, refreshLabel, REQUIRED_LEVELS, requirementSummary } from "../../lib/competence";
import { ErrorNotice, FormError } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";
import Switch from "../ui/Switch";

const Buttons = ({ onClose, pending, disabled, saveLabel = "Save" }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type="main" size="md" disabled={pending || disabled} loading={pending}>
      {pending ? "Saving…" : saveLabel}
    </CTAButton>
  </div>
);

const useSave = (onClose) => {
  const mutation = useCompetenceMutation();
  const { showToast } = useToast();
  const run = (payload) =>
    mutation.mutate(payload, {
      onSuccess: () => onClose(),
      onError: (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) }),
    });
  return { mutation, run };
};

/** Add a category or rename / describe one. The key is made from the name once and never changes. */
const CategoryDialog = ({ existing, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const [label, setLabel] = useState(existing?.label ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const save = (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    const body = { label: label.trim(), description: description.trim() || null };
    run(existing ? { action: "updateCategory", id: existing.id, body } : { action: "createCategory", body });
  };
  return (
    <Dialog title={existing ? `Edit ${existing.label}` : "Add a category"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Name" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} placeholder="e.g. Welding" />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} hint="Optional" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!label.trim()} />
      </form>
    </Dialog>
  );
};

/** Add a skill or edit one. Its code is fixed once it is created. */
const SkillDialog = ({ existing, categories, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const [code, setCode] = useState(existing?.code ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [categoryId, setCategoryId] = useState(existing?.category.id ?? null);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [refresh, setRefresh] = useState(existing?.refreshMonths ? String(existing.refreshMonths) : "");
  const refreshNumber = refresh.trim() === "" ? null : Number(refresh);
  const refreshOk = refreshNumber === null || (Number.isInteger(refreshNumber) && refreshNumber >= 1 && refreshNumber <= 120);
  const ready = name.trim() && categoryId && (existing || code.trim()) && refreshOk;
  const options = categories.filter((c) => c.active || c.id === existing?.category.id).map((c) => ({ value: c.id, label: c.label }));
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { name: name.trim(), categoryId, description: description.trim() || null, refreshMonths: refreshNumber };
    run(existing ? { action: "updateSkill", id: existing.id, body } : { action: "createSkill", body: { ...body, code: code.trim() } });
  };
  return (
    <Dialog title={existing ? `Edit ${existing.name}` : "Add a skill"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Code" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={40} disabled={!!existing} placeholder="e.g. CMM-01" hint={existing ? "A code never changes once the skill is created" : "Short and unique"} />
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. CMM operation" />
        <ComboField label="Category" required value={categoryId} onChange={setCategoryId} options={options} placeholder="Choose a category" />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} hint="Optional: what being competent means" />
        <Field
          label="Reassess every (months)"
          type="number"
          min={1}
          max={120}
          value={refresh}
          onChange={(e) => setRefresh(e.target.value)}
          error={refreshOk ? undefined : "Use a whole number from 1 to 120, or leave it empty"}
          hint="Optional. Leave empty if the skill does not need reassessing."
        />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} />
      </form>
    </Dialog>
  );
};

/** Add a position or edit one. Its code is fixed once it is created. */
const PositionDialog = ({ existing, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const [code, setCode] = useState(existing?.code ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const ready = name.trim() && (existing || code.trim());
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    const body = { name: name.trim(), description: description.trim() || null };
    run(existing ? { action: "updatePosition", id: existing.id, body } : { action: "createPosition", body: { ...body, code: code.trim() } });
  };
  return (
    <Dialog title={existing ? `Edit ${existing.name}` : "Add a position"} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <Field label="Code" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={40} disabled={!!existing} placeholder="e.g. CMM-INSP" hint={existing ? "A code never changes once the position is created" : "Short and unique"} />
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. CMM inspector" />
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} hint="Optional" />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} />
      </form>
    </Dialog>
  );
};

/** What a position requires: the skills and the level each needs. Saved as a whole list. */
const PositionSkillsDialog = ({ position, skills, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const [rows, setRows] = useState(position.skills.map((s) => ({ skillId: s.skillId, name: s.name, category: s.category, requiredLevel: s.requiredLevel })));
  const [adding, setAdding] = useState(null);
  const chosen = new Set(rows.map((r) => r.skillId));
  const available = skills.filter((s) => s.active && !chosen.has(s.id)).map((s) => ({ value: s.id, label: s.name, hint: s.category.label }));
  const levelOptions = REQUIRED_LEVELS.map((l) => ({ value: l.value, label: `${l.value} · ${l.label}`, hint: l.hint }));
  const add = (id) => {
    const s = skills.find((k) => k.id === id);
    if (!s) return;
    setRows((rs) => [...rs, { skillId: s.id, name: s.name, category: s.category.label, requiredLevel: 3 }]);
    setAdding(null);
  };
  const save = (e) => {
    e.preventDefault();
    run({ action: "setPositionSkills", id: position.id, body: { skills: rows.map((r) => ({ skillId: r.skillId, requiredLevel: Number(r.requiredLevel) })) } });
  };
  return (
    <Dialog title={`Skills required by ${position.name}`} onClose={onClose} width="max-w-2xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-sm text-secondary-text">No skills yet. Add the skills a person in this position must have, and the level each needs.</p>
        ) : (
          <ul aria-label="Required skills" className="flex flex-col divide-y divide-border-color">
            {rows.map((r, i) => (
              <li key={r.skillId} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-primary-text">{r.name}</span>
                  <span className="block text-xs text-secondary-text">{r.category}</span>
                </div>
                <div className="w-56">
                  <ComboField
                    ariaLabel={`Required level for ${r.name}`}
                    value={r.requiredLevel}
                    onChange={(v) => setRows((rs) => rs.map((x, n) => (n === i ? { ...x, requiredLevel: v ?? 3 } : x)))}
                    options={levelOptions}
                    required
                  />
                </div>
                <button type="button" aria-label={`Remove ${r.name}`} className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer" onClick={() => setRows((rs) => rs.filter((_, n) => n !== i))}>
                  <Trash2Icon />
                </button>
              </li>
            ))}
          </ul>
        )}
        <ComboField label="Add a skill" value={adding} onChange={(v) => v && add(v)} options={available} placeholder={available.length ? "Choose a skill to add" : "Every active skill is already listed"} disabled={available.length === 0} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} />
      </form>
    </Dialog>
  );
};

/** Retiring a skill or a position needs a reason, which is kept. */
const RetireDialog = ({ kind, item, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const [reason, setReason] = useState("");
  const save = (e) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    run({ action: kind === "skill" ? "retireSkill" : "retirePosition", id: item.id, body: { reason: reason.trim() } });
  };
  return (
    <Dialog title={`Retire ${item.name}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <p className="text-sm text-secondary-text">
          A retired {kind} is kept with its history but can no longer be chosen. You can bring it back later.
        </p>
        <Field label="Why is it retired?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={reason.trim().length < 3} saveLabel="Retire" />
      </form>
    </Dialog>
  );
};

const IconButton = ({ label, onClick, children }) => (
  <button type="button" aria-label={label} className="rounded-lg p-1.5 text-primary-text hover:bg-border-color/50 cursor-pointer" onClick={onClick}>
    {children}
  </button>
);

const AddButton = ({ onClick, children }) => (
  <CTAButton buttonType="button" type="main" size="lg" onClick={onClick}>
    <span className="flex items-center gap-1">
      <PlusIcon /> {children}
    </span>
  </CTAButton>
);

/** Settings → Data Management → Competence: categories, skills, and the positions that say which skills at which level each needs. */
const SettingsCompetence = () => {
  const { can } = usePermissions();
  const canManage = can("competence.manage");
  const categories = useCompetenceCategories({ all: true });
  const skills = useCompetenceSkills({ all: true });
  const positions = useCompetencePositions({ all: true });
  const mutation = useCompetenceMutation();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState(null);
  const active = useMemo(() => (skills.data?.data ?? []).filter((s) => s.active), [skills.data]);
  const retired = useMemo(() => (skills.data?.data ?? []).filter((s) => !s.active), [skills.data]);

  if (categories.isLoading || skills.isLoading || positions.isLoading) return <LoadingScreen />;
  const error = categories.error || skills.error || positions.error;
  if (error) return <ErrorNotice error={error} />;

  const fail = (err) => showToast({ type: "error", title: "Not saved", message: describeApiError(err) });
  const toggleCategory = (c, on) => mutation.mutate({ action: "updateCategory", id: c.id, body: { active: on } }, { onError: fail });
  const reactivate = (kind, item) => mutation.mutate({ action: kind === "skill" ? "reactivateSkill" : "reactivatePosition", id: item.id }, { onError: fail });

  const SkillRow = ({ s }) => (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`text-sm font-medium ${s.active ? "text-primary-text" : "text-secondary-text"}`}>
          {s.name} <span className="font-normal text-secondary-text">· {s.code}</span>
        </span>
        {s.description && <span className="text-xs text-secondary-text">{s.description}</span>}
        {!s.active && s.retiredReason && <span className="text-xs text-secondary-text">Retired: {s.retiredReason}</span>}
      </div>
      <span className="w-32 text-right text-xs text-secondary-text">{refreshLabel(s.refreshMonths)}</span>
      <span className="w-28 text-right text-xs tabular-nums text-secondary-text">
        {s.positions} {s.positions === 1 ? "position" : "positions"}
      </span>
      {canManage &&
        (s.active ? (
          <>
            <IconButton label={`Edit ${s.name}`} onClick={() => setDialog({ type: "skill", item: s })}>
              <PencilIcon />
            </IconButton>
            <CTAButton buttonType="button" type="neutral" onClick={() => setDialog({ type: "retire-skill", item: s })}>
              Retire
            </CTAButton>
          </>
        ) : (
          <CTAButton buttonType="button" type="neutral" onClick={() => reactivate("skill", s)}>
            Bring back
          </CTAButton>
        ))}
    </li>
  );

  return (
    <div className="flex w-full flex-col gap-4">
      <MenuCard
        title="Skill categories"
        subtitle="Groups for the skills list and the matrix. Switch one off to stop it being chosen; skills already in it keep it."
        action={canManage && <AddButton onClick={() => setDialog({ type: "category" })}>Add category</AddButton>}>
        <ul aria-label="Skill categories" className="flex flex-col divide-y divide-border-color">
          {categories.data.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`text-sm font-medium ${c.active ? "text-primary-text" : "text-secondary-text"}`}>{c.label}</span>
                {c.description && <span className="text-xs text-secondary-text">{c.description}</span>}
              </div>
              <span className="w-24 text-right text-xs tabular-nums text-secondary-text">
                {c.skills} {c.skills === 1 ? "skill" : "skills"}
              </span>
              <Switch checked={c.active} disabled={!canManage} onChange={(e) => toggleCategory(c, e.target.checked)} aria-label={`${c.label} is in use`} />
              {canManage && (
                <IconButton label={`Edit ${c.label}`} onClick={() => setDialog({ type: "category", item: c })}>
                  <PencilIcon />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      </MenuCard>

      <MenuCard
        title="Skills"
        subtitle="What people can be assessed on. Each has a code, a category and, if it needs reassessing, how often."
        action={canManage && <AddButton onClick={() => setDialog({ type: "skill" })}>Add skill</AddButton>}>
        {active.length === 0 ? (
          <p className="text-sm text-secondary-text">No skills yet.{canManage ? " Add the first one." : ""}</p>
        ) : (
          groupByCategory(active).map((g) => (
            <section key={g.label} aria-label={g.label} className="mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-text">{g.label}</h3>
              <ul className="flex flex-col divide-y divide-border-color">
                {g.items.map((s) => (
                  <SkillRow key={s.id} s={s} />
                ))}
              </ul>
            </section>
          ))
        )}
        {retired.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-secondary-text">Retired skills ({retired.length})</summary>
            <ul aria-label="Retired skills" className="flex flex-col divide-y divide-border-color">
              {retired.map((s) => (
                <SkillRow key={s.id} s={s} />
              ))}
            </ul>
          </details>
        )}
      </MenuCard>

      <MenuCard
        title="Positions"
        subtitle="A position says which skills, at which level, a person doing that job needs. People can hold several positions."
        action={canManage && <AddButton onClick={() => setDialog({ type: "position" })}>Add position</AddButton>}>
        {positions.data.data.filter((p) => p.active).length === 0 ? (
          <p className="text-sm text-secondary-text">No positions yet.{canManage ? " Add the first one." : ""}</p>
        ) : null}
        <ul aria-label="Positions" className="flex flex-col divide-y divide-border-color">
          {positions.data.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`text-sm font-medium ${p.active ? "text-primary-text" : "text-secondary-text"}`}>
                  {p.name} <span className="font-normal text-secondary-text">· {p.code}</span>
                </span>
                {p.description && <span className="text-xs text-secondary-text">{p.description}</span>}
                <span className="text-xs text-secondary-text">{requirementSummary(p)}</span>
                {!p.active && p.retiredReason && <span className="text-xs text-secondary-text">Retired: {p.retiredReason}</span>}
              </div>
              {canManage &&
                (p.active ? (
                  <>
                    <CTAButton buttonType="button" type="secondary" onClick={() => setDialog({ type: "position-skills", item: p })}>
                      Required skills
                    </CTAButton>
                    <IconButton label={`Edit ${p.name}`} onClick={() => setDialog({ type: "position", item: p })}>
                      <PencilIcon />
                    </IconButton>
                    <CTAButton buttonType="button" type="neutral" onClick={() => setDialog({ type: "retire-position", item: p })}>
                      Retire
                    </CTAButton>
                  </>
                ) : (
                  <CTAButton buttonType="button" type="neutral" onClick={() => reactivate("position", p)}>
                    Bring back
                  </CTAButton>
                ))}
            </li>
          ))}
        </ul>
      </MenuCard>

      {dialog?.type === "category" && <CategoryDialog existing={dialog.item} onClose={() => setDialog(null)} />}
      {dialog?.type === "skill" && <SkillDialog existing={dialog.item} categories={categories.data.data} onClose={() => setDialog(null)} />}
      {dialog?.type === "position" && <PositionDialog existing={dialog.item} onClose={() => setDialog(null)} />}
      {dialog?.type === "position-skills" && <PositionSkillsDialog position={dialog.item} skills={skills.data.data} onClose={() => setDialog(null)} />}
      {dialog?.type === "retire-skill" && <RetireDialog kind="skill" item={dialog.item} onClose={() => setDialog(null)} />}
      {dialog?.type === "retire-position" && <RetireDialog kind="position" item={dialog.item} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default SettingsCompetence;
