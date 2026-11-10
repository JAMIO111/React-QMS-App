import { useState } from "react";
import { Link } from "react-router-dom";
import Field from "../../ui/Field";
import MenuCard from "../../ui/MenuCard";
import RHFComboBox from "../../ui/RHFComboBox";
import RHFDatePickerPopout from "../../ui/RHFDatePickerPopout";
import Dialog from "../../ui/Dialog";
import ReasonDialog from "../../ncr/ReasonDialog";
import { NcrPicker } from "../../ncr/Pickers";
import { useCapaMutation, useCapaPeople } from "../../../hooks/useCapa";
import { SEVERITIES, SOURCES, isRunning, ncrHref } from "../../../lib/capa";
import { usePermissions } from "../../../hooks/useQmsApi";
import CustomFieldsCard from "../../custom-fields/CustomFieldsCard";
import { formatDay } from "../../../lib/qualityAlerts";
import { stageOf as ncrStageOf } from "../../../lib/ncr";
import { FormError, TextAreaField } from "../../master-data/shared";
import CTAButton from "@/components/CTAButton";

const HeaderForm = ({ capa, editable }) => {
  const mutation = useCapaMutation();
  const people = useCapaPeople({ enabled: editable });
  const [form, setForm] = useState({
    title: capa.title, problemStatement: capa.problemStatement ?? "", source: capa.source, severity: capa.severity, externalReference: capa.externalReference ?? "",
    ownerMembershipId: capa.owner?.membershipId ?? null, dueDate: capa.dueDate,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const owners = [...(people.data ?? []).map((p) => ({ id: p.membershipId, name: p.name }))];
  if (capa.owner && !owners.some((o) => o.id === capa.owner.membershipId)) owners.push({ id: capa.owner.membershipId, name: capa.owner.name });

  const changes = {};
  if (form.title.trim() !== capa.title) changes.title = form.title.trim();
  if (form.problemStatement.trim() !== (capa.problemStatement ?? "")) changes.problemStatement = form.problemStatement.trim() || null;
  if (form.source !== capa.source) changes.source = form.source;
  if (form.severity !== capa.severity) changes.severity = form.severity;
  if (form.externalReference.trim() !== (capa.externalReference ?? "")) changes.externalReference = form.externalReference.trim() || null;
  if (form.ownerMembershipId !== (capa.owner?.membershipId ?? null)) changes.ownerMembershipId = form.ownerMembershipId;
  if (form.dueDate !== capa.dueDate) changes.dueDate = form.dueDate;
  const dirty = Object.keys(changes).length > 0;

  return (
    <MenuCard title="The problem" subtitle="What went wrong, how serious it is and who is responsible" as="form" aria-label="8D details" bodyClassName="flex flex-col gap-3" noValidate
      onSubmit={(e) => { e.preventDefault(); if (dirty) mutation.mutate({ action: "update", id: capa.id, body: changes }); }}>
      <Field label="Title" value={form.title} onChange={set("title")} disabled={!editable} required maxLength={200} />
      <TextAreaField label="Problem statement" required value={form.problemStatement} onChange={set("problemStatement")} disabled={!editable} rows={4} maxLength={5000}
        hint="State the problem as a fact the customer would recognise, without naming a cause" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <RHFComboBox label="Source" value={form.source} onChange={(v) => setForm((f) => ({ ...f, source: v ?? f.source }))} options={SOURCES} sort={false} clearable={false} disabled={!editable} />
        <RHFComboBox label="Severity" value={form.severity} onChange={(v) => setForm((f) => ({ ...f, severity: v }))} options={SEVERITIES} sort={false} placeholder="Not set" disabled={!editable} />
        <Field label="Customer or supplier reference" value={form.externalReference} onChange={set("externalReference")} disabled={!editable} maxLength={100} hint="e.g. their 8D or SCAR number" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RHFComboBox label="Owner" value={form.ownerMembershipId} onChange={(v) => setForm((f) => ({ ...f, ownerMembershipId: v }))} options={owners} placeholder="No owner" disabled={!editable} />
        <RHFDatePickerPopout label="Due date" valueFormat="iso" clearable value={form.dueDate} onChange={(v) => setForm((f) => ({ ...f, dueDate: v ?? null }))} placeholder="No due date" disabled={!editable} />
      </div>
      <FormError error={mutation.error} />
      {editable && (
        <div className="flex justify-end">
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!dirty || mutation.isPending || !form.title.trim()} loading={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save changes"}</CTAButton>
        </div>
      )}
    </MenuCard>
  );
};

const LinkNcrDialog = ({ capa, onClose }) => {
  const mutation = useCapaMutation();
  const [picked, setPicked] = useState(null);
  return (
    <Dialog title="Link a non-conformance" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (picked) mutation.mutate({ action: "linkNcr", id: capa.id, body: { ncrId: picked } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">One 8D can address many non-conformances. The same non-conformance can also be in other 8Ds.</p>
        <NcrPicker label="Non-conformance" required value={picked} onChange={(id) => setPicked(id)} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!picked || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Linking…" : "Link"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

const NcrLinks = ({ capa, editable }) => {
  const mutation = useCapaMutation();
  const [linking, setLinking] = useState(false);
  const [ending, setEnding] = useState(null);
  const live = capa.ncrs.filter((n) => !n.endedAt);
  const ended = capa.ncrs.filter((n) => n.endedAt);
  return (
    <MenuCard title="Non-conformances addressed" subtitle={`${live.length} linked`}
      action={editable ? <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setLinking(true)}>Link a non-conformance</CTAButton> : undefined}>
      {live.length === 0 ? (
        <p className="text-sm text-secondary-text">No non-conformance is linked. An 8D can stand alone, or be started from a non-conformance.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-color" aria-label="Linked non-conformances">
          {live.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="flex min-w-0 flex-col">
                {n.reference ? <Link to={ncrHref(n)} className="font-medium text-link-color hover:underline">{n.reference}</Link> : <span className="text-secondary-text">Not available to you</span>}
                <span className="truncate text-primary-text">{n.title}</span>
              </div>
              <div className="flex items-center gap-3">
                {n.stage && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ncrStageOf(n.stage).tone}`}>{ncrStageOf(n.stage).label}</span>}
                <span className="text-xs text-secondary-text">Linked {formatDay(n.linkedAt.slice(0, 10))}</span>
                {editable && <CTAButton buttonType="button" type="neutral" size="md" aria-label={`End link to ${n.reference ?? "non-conformance"}`} onClick={() => { mutation.reset(); setEnding(n); }}>End link</CTAButton>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {ended.length > 0 && (
        <details className="mt-3 text-sm text-secondary-text">
          <summary className="cursor-pointer">{ended.length} earlier {ended.length === 1 ? "link" : "links"} ended</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {ended.map((n) => (
              <li key={n.id}>{n.reference ?? "A non-conformance"} · ended {formatDay(n.endedAt.slice(0, 10))}: {n.endReason}</li>
            ))}
          </ul>
        </details>
      )}
      {linking && <LinkNcrDialog capa={capa} onClose={() => setLinking(false)} />}
      {ending && (
        <ReasonDialog
          title={`End the link to ${ending.reference ?? "this non-conformance"}?`}
          label="Why is it no longer part of this 8D?"
          confirmText="End link"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setEnding(null)}
          onConfirm={(reason) => mutation.mutate({ action: "unlinkNcr", id: ending.id, body: { reason } }, { onSuccess: () => setEnding(null) })}
        />
      )}
    </MenuCard>
  );
};

/** D0: the problem and the non-conformances this 8D addresses. */
const D0Initiate = ({ capa, editable }) => {
  const { can } = usePermissions();
  return (
    <div className="flex flex-col gap-4">
      <HeaderForm key={capa.updatedAt} capa={capa} editable={editable} />
      {/* Custom fields are not part of D0's step lock: they stay editable while the 8D runs. */}
      <CustomFieldsCard entityType="capa" record={capa} editable={can("capa.manage") && isRunning(capa.stage)} />
      <NcrLinks capa={capa} editable={editable} />
    </div>
  );
};

export default D0Initiate;
