import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { describeApiError } from "../../lib/api-client";
import { useToast } from "../../contexts/ToastProvider";
import { useCompetenceMutation, useCompetencePositions, useCompetenceSkills } from "../../hooks/useCompetence";
import { ATTENDEE_STATUS, attendeeStatusLabel, kindLabel, LEVELS, levelLabel, pillClass, refreshLabel, statusClass, statusLabel } from "../../lib/competence";
import { todayIso } from "../../lib/localDate";
import { FormError } from "../master-data/shared";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import { Link } from "react-router-dom";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import StatTile from "../ui/StatTile";

const Pill = ({ status, children }) => <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(status)}`}>{children ?? statusLabel(status)}</span>;

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

const Buttons = ({ onClose, pending, disabled, saveLabel }) => (
  <div className="flex justify-end gap-2">
    <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>
      Cancel
    </CTAButton>
    <CTAButton buttonType="submit" type="main" size="md" disabled={pending || disabled} loading={pending}>
      {pending ? "Saving…" : saveLabel}
    </CTAButton>
  </div>
);

/** Record an assessment: level on the 0–4 scale, the date, an optional expiry (the skill's refresh interval is used when left empty) and a note. */
export const AssessDialog = ({ employee, skill, current, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const skills = useCompetenceSkills();
  const [skillId, setSkillId] = useState(skill?.id ?? null);
  const [level, setLevel] = useState(current?.level ?? null);
  const [assessedOn, setAssessedOn] = useState(todayIso());
  const [expiresOn, setExpiresOn] = useState("");
  const [note, setNote] = useState("");
  const chosen = (skills.data?.data ?? []).find((s) => s.id === skillId) ?? skill;
  const lower = current && level !== null && level < current.level;
  const ready = skillId && level !== null && assessedOn && (!lower || note.trim().length >= 3);
  const save = (e) => {
    e.preventDefault();
    if (!ready) return;
    run({ action: "assess", id: employee.id, body: { skillId, level, assessedOn, expiresOn: expiresOn || null, note: note.trim() || null } });
  };
  return (
    <Dialog title={`Assess ${employee.name}`} onClose={onClose} width="max-w-xl">
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <ComboField
          label="Skill"
          required
          value={skillId}
          onChange={setSkillId}
          disabled={!!skill}
          options={(skills.data?.data ?? (skill ? [skill] : [])).map((s) => ({ value: s.id, label: s.name, hint: s.code }))}
          placeholder="Choose a skill"
        />
        <ComboField
          label="Level"
          required
          value={level}
          onChange={setLevel}
          options={LEVELS.map((l) => ({ value: l.value, label: `${l.value} · ${l.label}`, hint: l.hint }))}
          placeholder="Choose a level"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <RHFDatePickerPopout label="Assessed on" required value={assessedOn} onChange={(v) => setAssessedOn(v ?? "")} valueFormat="iso" maxDate={new Date()} />
          <RHFDatePickerPopout
            label="Valid until"
            value={expiresOn}
            onChange={(v) => setExpiresOn(v ?? "")}
            valueFormat="iso"
            clearable
            minDate={new Date(Date.now() + 86_400_000)}
            placeholder={chosen?.refreshMonths ? `Default: ${refreshLabel(chosen.refreshMonths).toLowerCase()}` : "No expiry"}
            hint="Leave empty to follow the skill's refresh interval"
          />
        </div>
        <Field label="Note" required={!!lower} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} hint={lower ? "Say why the level is lower than before" : "Optional: what you observed"} />
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!ready} saveLabel="Record assessment" />
      </form>
    </Dialog>
  );
};

const GivePositionDialog = ({ employee, held, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const positions = useCompetencePositions();
  const [positionId, setPositionId] = useState(null);
  const [startedOn, setStartedOn] = useState(todayIso());
  const open = new Set(held.filter((h) => !h.endedOn).map((h) => h.position.id));
  const options = (positions.data?.data ?? []).filter((p) => !open.has(p.id)).map((p) => ({ value: p.id, label: p.name, hint: p.code }));
  const save = (e) => {
    e.preventDefault();
    if (!positionId || !startedOn) return;
    run({ action: "assignPosition", id: employee.id, body: { positionId, startedOn } });
  };
  return (
    <Dialog title={`Give ${employee.name} a position`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <ComboField label="Position" required value={positionId} onChange={setPositionId} options={options} placeholder={options.length ? "Choose a position" : "No other positions to give"} disabled={options.length === 0} />
        <RHFDatePickerPopout label="Started on" required value={startedOn} onChange={(v) => setStartedOn(v ?? "")} valueFormat="iso" maxDate={new Date()} />
        <p className="text-sm text-secondary-text">The position's required skills then show against this person. Earlier stints in a position are kept as history.</p>
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!positionId || !startedOn} saveLabel="Give position" />
      </form>
    </Dialog>
  );
};

const EndPositionDialog = ({ held, onClose }) => {
  const { mutation, run } = useSave(onClose);
  const [endedOn, setEndedOn] = useState(todayIso());
  const save = (e) => {
    e.preventDefault();
    run({ action: "endPosition", id: held.id, body: { endedOn } });
  };
  return (
    <Dialog title={`End ${held.position.name}`} onClose={onClose}>
      <form noValidate onSubmit={save} className="flex flex-col gap-3">
        <RHFDatePickerPopout label="Ended on" required value={endedOn} onChange={(v) => setEndedOn(v ?? "")} valueFormat="iso" minDate={new Date(`${held.startedOn}T00:00:00`)} maxDate={new Date()} />
        <p className="text-sm text-secondary-text">Its requirements stop applying from now. The assessments stay.</p>
        <FormError error={mutation.error} />
        <Buttons onClose={onClose} pending={mutation.isPending} disabled={!endedOn} saveLabel="End position" />
      </form>
    </Dialog>
  );
};

const History = ({ items }) => (
  <ul aria-label="Assessment history" className="mt-2 flex flex-col gap-1 border-l border-border-color pl-3 text-xs text-secondary-text">
    {items.map((h) => (
      <li key={h.id}>
        <span className="font-medium text-primary-text">
          {levelLabel(h.level)} ({h.level})
        </span>{" "}
        · {h.assessedOn}
        {h.expiresOn ? ` · until ${h.expiresOn}` : ""}
        {h.assessor ? ` · by ${h.assessor}` : ""}
        {h.current ? " · current" : ""}
        {h.note ? ` · "${h.note}"` : ""}
      </li>
    ))}
  </ul>
);

const SkillRow = ({ row, canAssess, onAssess }) => {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} history for ${row.skill.name}`} onClick={() => setOpen(!open)} className="text-icon-color">
          <Chevron className="h-4 w-4" />
        </button>
        <div className="min-w-48 flex-1">
          <p className="text-sm font-medium text-primary-text">
            {row.skill.name} <span className="font-normal text-secondary-text">· {row.skill.category.label}</span>
          </p>
          <p className="text-xs text-secondary-text">
            {row.level === null ? "Not assessed" : `${levelLabel(row.level)} (${row.level})`}
            {row.required !== null ? ` · needs ${row.required}` : ""}
            {row.assessedOn ? ` · assessed ${row.assessedOn}${row.assessor ? ` by ${row.assessor}` : ""}` : ""}
            {row.expiresOn ? ` · ${row.expiry === "expired" ? "expired" : "valid until"} ${row.expiresOn}` : ""}
          </p>
        </div>
        <Pill status={row.status} />
        {canAssess && row.skill.active && (
          <CTAButton buttonType="button" type="neutral" aria-label={`Assess ${row.skill.name}`} onClick={() => onAssess(row)}>
            Assess
          </CTAButton>
        )}
      </div>
      {open && (row.history.length ? <History items={row.history} /> : <p className="mt-2 pl-7 text-xs text-secondary-text">No assessments yet.</p>)}
    </li>
  );
};

/**
 * One person's competence: what they hold (positions with dates), every skill that is required of them or assessed, how each stands, and the history behind it.
 * Shared by the person page (managers and assessors) and "My competence" (read only). Information only: nothing here blocks work.
 */
const ProfileView = ({ profile, canAssess = false, canManage = false }) => {
  const [dialog, setDialog] = useState(null);
  const { employee, positions, skills, summary } = profile;
  const current = positions.filter((p) => !p.endedOn);
  const past = positions.filter((p) => p.endedOn);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <StatTile label="Required skills" value={summary.required} />
        <StatTile label="Gaps" value={summary.gaps} note="below the level needed or not assessed" />
        <StatTile label="Expired" value={summary.expired} />
        <StatTile label="Expiring soon" value={summary.expiring} />
      </div>

      <MenuCard
        title="Positions"
        subtitle={[employee.department?.name, employee.site?.name].filter(Boolean).join(" · ") || undefined}
        action={
          canManage && (
            <CTAButton buttonType="button" type="secondary" icon={PlusIcon} onClick={() => setDialog({ type: "position" })}>
              Give a position
            </CTAButton>
          )
        }>
        {current.length === 0 ? (
          <p className="text-sm text-secondary-text">No position yet, so no skills are required of them.</p>
        ) : (
          <ul aria-label="Current positions" className="flex flex-col divide-y divide-border-color">
            {current.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="flex-1 text-sm text-primary-text">
                  {p.position.name} <span className="text-secondary-text">· since {p.startedOn}</span>
                </span>
                {canManage && (
                  <CTAButton buttonType="button" type="neutral" aria-label={`End ${p.position.name}`} onClick={() => setDialog({ type: "end", held: p })}>
                    End
                  </CTAButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {past.length > 0 && (
          <details className="mt-2 text-sm text-secondary-text">
            <summary className="cursor-pointer">Earlier positions ({past.length})</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {past.map((p) => (
                <li key={p.id}>
                  {p.position.name} · {p.startedOn} to {p.endedOn}
                </li>
              ))}
            </ul>
          </details>
        )}
      </MenuCard>

      <MenuCard
        title="Skills"
        subtitle="Those their positions require, and any others they have been assessed on"
        action={
          canAssess && (
            <CTAButton buttonType="button" type="main" icon={PlusIcon} onClick={() => setDialog({ type: "assess" })}>
              Record an assessment
            </CTAButton>
          )
        }>
        {skills.length === 0 ? (
          <p className="text-sm text-secondary-text">Nothing is required of them yet and no assessments have been made.</p>
        ) : (
          <ul aria-label="Skills" className="flex flex-col divide-y divide-border-color">
            {skills.map((row) => (
              <SkillRow key={row.skill.id} row={row} canAssess={canAssess} onAssess={(r) => setDialog({ type: "assess", row: r })} />
            ))}
          </ul>
        )}
      </MenuCard>

      {profile.training?.length > 0 && (
        <MenuCard title="Training" subtitle="Sessions they were on. Training is evidence; it does not set a level by itself.">
          <ul aria-label="Training" className="flex flex-col divide-y divide-border-color">
            {profile.training.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-48 flex-1">
                  <Link to={`/Competence/Training/${t.sessionId}`} className="text-sm font-medium text-primary-text hover:underline">
                    {t.title}
                  </Link>
                  <p className="text-xs text-secondary-text">
                    {t.reference} · {kindLabel(t.kind)} · {t.completedOn ? `${t.status === "failed" ? "failed" : "completed"} ${t.completedOn}` : `started ${t.startsOn}`}
                  </p>
                </div>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pillClass(ATTENDEE_STATUS, t.status)}`}>{attendeeStatusLabel(t.status)}</span>
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      {profile.documentsRead?.length > 0 && (
        <MenuCard title="Documents read" subtitle="Documents that train a skill, read and acknowledged. Evidence only; it does not set a level.">
          <ul aria-label="Documents read" className="flex flex-col divide-y divide-border-color">
            {profile.documentsRead.map((d) => (
              <li key={`${d.documentId}-${d.letter}`} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-48 flex-1">
                  <Link to={`/Documentation/Documents/${d.documentId}`} className="text-sm font-medium text-primary-text hover:underline">
                    {d.number} rev {d.letter} · {d.title}
                  </Link>
                  <p className="text-xs text-secondary-text">
                    Acknowledged {new Date(d.acknowledgedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · {d.skills.map((k) => k.name).join(", ")}
                    {d.revisionStatus !== "effective" ? " · since replaced" : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      {dialog?.type === "assess" && <AssessDialog employee={employee} skill={dialog.row?.skill} current={dialog.row ? { level: dialog.row.level } : null} onClose={() => setDialog(null)} />}
      {dialog?.type === "position" && <GivePositionDialog employee={employee} held={positions} onClose={() => setDialog(null)} />}
      {dialog?.type === "end" && <EndPositionDialog held={dialog.held} onClose={() => setDialog(null)} />}
    </div>
  );
};

export default ProfileView;
