import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import { PartPicker } from "../ncr/Pickers";
import { useSites } from "../../hooks/useQmsApi";
import { useMachines, useResolution } from "../../hooks/useProcessControl";
import { useInspectionMutation } from "../../hooks/useInspection";
import { TRIGGER_LABEL } from "../../lib/inspection";
import { buttonClass, FormError, SelectField } from "../master-data/shared";
import ResolutionView from "../process-control/ResolutionView";
import LoadingScreen from "../ui/LoadingScreen";

/**
 * Start an in-process inspection: production context (site, part, operation, machine, work order,
 * lot, serial, trigger), a live preview of the requirements the operator will get, then Start —
 * which resolves them again in the database and freezes them with the inspection.
 */
const StartInspectionPage = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sites = useSites();
  const machines = useMachines();
  const mutation = useInspectionMutation();
  const siteList = sites.data?.data ?? [];
  const [form, setForm] = useState({
    siteId: null,
    partId: params.get("partId"),
    part: null,
    operationCode: params.get("operation") ?? "",
    machineId: null,
    workOrder: "",
    lot: "",
    serial: "",
    triggerType: "first_off",
  });
  const siteId = form.siteId ?? (siteList.length === 1 ? siteList[0].id : null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [appliedOp, setAppliedOp] = useState(form.operationCode.trim());
  const preview = useResolution({ partId: form.partId, operationCode: appliedOp || undefined, siteId: siteId ?? undefined });
  const ready = !!siteId && preview.data?.status === "ok";

  const submit = (e) => {
    e.preventDefault();
    mutation.mutate(
      {
        path: "/inspections",
        body: {
          siteId,
          partId: form.partId,
          ...(appliedOp ? { operationCode: appliedOp } : {}),
          machineId: form.machineId,
          workOrder: form.workOrder,
          lot: form.lot,
          serial: form.serial,
          triggerType: form.triggerType,
        },
      },
      { onSuccess: (rec) => navigate(`/Inspections/${rec.id}`, { replace: true }) }
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <Link to="/Inspections" className="flex w-fit items-center gap-1 text-sm text-link-color hover:underline">
        <ArrowLeftIcon className="h-4 w-4" /> Inspections
      </Link>
      <h1 className="text-2xl font-semibold text-primary-text">Start an inspection</h1>
      <MenuCard as="form" onSubmit={submit} title="What is being inspected" aria-label="Inspection context" bodyClassName="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <SelectField
            label="Site"
            required
            placeholder="Choose a site"
            value={siteId}
            onChange={(v) => setForm((f) => ({ ...f, siteId: v }))}
            options={siteList.map((s) => ({ value: s.id, label: s.name }))}
          />
          <PartPicker label="Part" required value={form.partId} current={form.part} onChange={(id, item) => setForm((f) => ({ ...f, partId: id ?? null, part: item ?? null }))} />
          <Field
            label="Operation"
            value={form.operationCode}
            onChange={set("operationCode")}
            onBlur={() => setAppliedOp(form.operationCode.trim())}
            maxLength={30}
            hint="Optional, e.g. OP-020 — leave empty for every operation"
          />
          <SelectField
            label="Machine"
            placeholder="Not recorded"
            value={form.machineId}
            onChange={(v) => setForm((f) => ({ ...f, machineId: v }))}
            options={(machines.data?.items ?? []).map((m) => ({ value: m.id, label: `${m.code} · ${m.name}` }))}
          />
          <Field label="Work order" value={form.workOrder} onChange={set("workOrder")} maxLength={60} />
          <Field label="Lot / batch" value={form.lot} onChange={set("lot")} maxLength={60} />
          <Field label="Serial" value={form.serial} onChange={set("serial")} maxLength={60} hint="When a single serialised unit is inspected" />
          <SelectField
            label="Trigger"
            required
            value={form.triggerType}
            onChange={(v) => setForm((f) => ({ ...f, triggerType: v }))}
            options={Object.entries(TRIGGER_LABEL).map(([value, label]) => ({ value, label }))}
          />
        </div>
        <FormError error={mutation.error} />
        <button type="submit" className={`${buttonClass.primary} self-start`} disabled={!ready || mutation.isPending}>
          {mutation.isPending ? "Starting…" : "Start inspection"}
        </button>
      </MenuCard>
      {form.partId && (
        <MenuCard title="Requirements" subtitle="Frozen with the inspection when it starts.">
          {preview.isLoading && <LoadingScreen size="sm" />}
          {preview.error && <FormError error={preview.error} />}
          {preview.data && <ResolutionView resolution={preview.data} />}
        </MenuCard>
      )}
    </div>
  );
};

export default StartInspectionPage;
