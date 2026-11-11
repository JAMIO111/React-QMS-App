import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeftIcon } from "@/components/icons";
import Field from "../ui/Field";
import MenuCard from "../ui/MenuCard";
import { PartPicker } from "../ncr/Pickers";
import { useSites } from "../../hooks/useQmsApi";
import { useMachines, useResolution } from "../../hooks/useProcessControl";
import { useInspectionMutation } from "../../hooks/useInspection";
import { needsLotSize, startTrigger } from "../../lib/inspection";
import { FormError, SelectField } from "../master-data/shared";
import ActiveAlertsBanner from "../documentation/ActiveAlertsBanner";
import DocumentsInForce from "../documents/DocumentsInForce";
import ResolutionView from "../process-control/ResolutionView";
import LoadingScreen from "../ui/LoadingScreen";
import CTAButton from "@/components/CTAButton";
import { CustomFieldInputs } from "../custom-fields/CustomFieldsCard";
import { withCustomValues } from "../../lib/customFields";

/**
 * Start an in-process inspection: production context (site, part, operation, machine, work order,
 * lot, lot size, serial), a live preview of the requirements the operator will get, then Start —
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
    lotSize: "",
  });
  const [customValues, setCustomValues] = useState({});
  const siteId = form.siteId ?? (siteList.length === 1 ? siteList[0].id : null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const [appliedOp, setAppliedOp] = useState(form.operationCode.trim());
  const preview = useResolution({ partId: form.partId, operationCode: appliedOp || undefined, siteId: siteId ?? undefined });
  const requirements = preview.data?.requirements ?? [];
  const lotSizeNeeded = needsLotSize(requirements);
  const lotSizeValid = /^[1-9]\d{0,8}$/.test(form.lotSize.trim());
  const ready = !!siteId && preview.data?.status === "ok" && (!lotSizeNeeded || lotSizeValid) && (!form.lotSize.trim() || lotSizeValid);

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
          ...(form.lotSize.trim() ? { lotSize: Number(form.lotSize) } : {}),
          triggerType: startTrigger(requirements),
          ...withCustomValues(customValues),
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
      <ActiveAlertsBanner partId={form.partId} machineId={form.machineId} operationCode={appliedOp || undefined} />
      <DocumentsInForce partId={form.partId || undefined} machineId={form.machineId || undefined} operationCode={appliedOp || undefined} />
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
          <Field
            label="Lot size (parts)"
            inputMode="numeric"
            value={form.lotSize}
            onChange={set("lotSize")}
            maxLength={9}
            error={form.lotSize.trim() && !lotSizeValid ? "Enter a whole number of parts" : undefined}
            hint={lotSizeNeeded ? "Required — the plan samples every N parts" : "Optional"}
          />
        </div>
        <CustomFieldInputs entityType="inspection" values={customValues} onChange={setCustomValues} />
        <FormError error={mutation.error} />
        <CTAButton buttonType="submit" type="main" size="lg" className="self-start" disabled={!ready || mutation.isPending} loading={mutation.isPending}>
          {mutation.isPending ? "Starting…" : "Start inspection"}
        </CTAButton>
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
