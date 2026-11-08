import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import { PartPicker } from "../ncr/Pickers";
import { OrderPickerWithCreate } from "../production/pickers";
import { useProductionSettings } from "../../hooks/useProduction";
import { usePermissions } from "../../hooks/useQmsApi";
import { buttonClass, FormError, SelectField } from "../master-data/shared";
import { useMachines } from "../../hooks/useProcessControl";
import { useJobMutation, useJobPreview } from "../../hooks/useJobs";
import { useOrganisation } from "../../contexts/OrganisationProvider";
import { lastMachine, rememberMachine } from "../../lib/jobs";

const useDebounced = (value, delay = 300) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
};

/**
 * Start a job. The part comes first: it resolves to the control plan in force (green when there is one, red with the resolver's reasons when there
 * is not). The operation is then chosen from the operations on that plan only, and the machine last. Site, start time and operator are filled in
 * by the server; the quantity is asked only when a check is sampled every N parts.
 */
const StartJobDialog = ({ onClose }) => {
  const navigate = useNavigate();
  const { organisationId } = useOrganisation();
  const remembered = lastMachine(organisationId);
  const [part, setPart] = useState({ id: null, item: null });
  const [operation, setOperation] = useState(null);
  const [machineId, setMachineId] = useState(remembered?.id ?? null);
  const [search, setSearch] = useState("");
  const [quantity, setQuantity] = useState("");
  const [order, setOrder] = useState({ id: null, item: null });
  const { can } = usePermissions();
  const settings = useProductionSettings();
  const canPickOrder = can("production.read");
  const orderRequired = canPickOrder && settings.requireProductionOrder;
  const machines = useMachines({ q: useDebounced(search) });
  const mutation = useJobMutation();

  const options = (machines.data?.items ?? []).map((m) => ({ id: m.id, name: `${m.code} · ${m.name}` }));
  const current = remembered?.id === machineId ? { id: remembered.id, name: remembered.name } : undefined;
  const single = useJobPreview({ partId: part.id });
  const planned = single.data && single.data.part.id === part.id ? single.data : null;
  // A plan with one operation needs no choosing; with several, the operator picks one.
  const chosen = operation ?? (planned?.operations.length === 1 ? planned.operations[0].code : null);
  const preview = useJobPreview({ partId: part.id, machineId, operationCode: chosen ?? undefined });
  const p = preview.data && preview.data.part.id === part.id && (preview.data.machine?.id ?? null) === machineId ? preview.data : null;
  const planOk = planned?.status === "ok";
  const qtyValid = /^[1-9]\d{0,8}$/.test(quantity.trim());
  const needsQty = !!p?.needsLotSize;
  const ready = !!p && planOk && p.status === "ok" && !!machineId && !!chosen && !!p.site && (!needsQty || qtyValid) && (!quantity.trim() || qtyValid) && (!orderRequired || !!order.id);

  const start = (e) => {
    e.preventDefault();
    const machine = options.find((o) => o.id === machineId) ?? current;
    mutation.mutate(
      { machineId, partId: part.id, operationCode: chosen, ...(quantity.trim() ? { lotSize: Number(quantity) } : {}), ...(order.id ? { productionOrderId: order.id } : {}) },
      {
        onSuccess: (job) => {
          if (machine) rememberMachine(organisationId, { id: machineId, name: machine.name.replace(/^.*? · /, "") });
          navigate(`/Jobs/${job.id}`);
        },
      }
    );
  };

  return (
    <Dialog title="Start a new job" onClose={onClose} width="max-w-xl">
      <form onSubmit={start} noValidate className="flex flex-col gap-4">
        <PartPicker
          label="Part number"
          required
          value={part.id}
          current={part.item}
          onChange={(id, item) => {
            setPart({ id: id ?? null, item: item ?? null });
            setOperation(null);
            setQuantity("");
            setOrder({ id: null, item: null });
          }}
        />
        {part.id && !planned && !single.error && (
          <div role="status" aria-busy="true" aria-label="Checking the control plan" className="flex items-center gap-3 rounded-lg border border-border-color bg-secondary-bg p-3">
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border-dark-color border-t-brand-primary" aria-hidden="true" />
            <div className="flex flex-1 flex-col gap-1.5" aria-hidden="true">
              <div className="h-3 w-3/4 rounded shimmer" />
              <div className="h-3 w-1/2 rounded shimmer" />
            </div>
            <span className="sr-only">Checking the control plan…</span>
          </div>
        )}
        {planned &&
          (planOk ? (
            <p role="status" className="rounded-lg border border-success-color/40 bg-success-color/10 p-3 text-sm text-primary-text">
              Control plan {planned.plan.planCode} rev {planned.plan.revisionCode} is in force · part revision {planned.partRevision ?? "—"} · {planned.requirementCount} {planned.requirementCount === 1 ? "check" : "checks"}
            </p>
          ) : (
            <div role="alert" className="rounded-lg border border-error-color/40 bg-error-color/10 p-3 text-sm text-primary-text">
              <p className="font-medium text-error-color">No valid control plan for this part, so a job cannot be started.</p>
              <ul className="mt-1 list-disc pl-5">
                {planned.problems.map((x) => (
                  <li key={x.code + x.message}>{x.message}</li>
                ))}
              </ul>
            </div>
          ))}
        {planOk && (
          <SelectField
            label="Operation"
            required
            placeholder="Choose the operation"
            value={chosen}
            onChange={setOperation}
            options={planned.operations.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}` }))}
          />
        )}
        {planOk && (
          <RHFComboBox
            label="Machine"
            required
            value={machineId}
            onChange={setMachineId}
            options={options}
            selectedOption={current}
            placeholder="Search machine code or name…"
            sort={false}
            filterLocally={false}
            onSearchChange={setSearch}
            emptyMessage={machines.isFetching ? "Searching…" : "No machines"}
          />
        )}
        {planOk && canPickOrder && planned && (
          <OrderPickerWithCreate
            label="Production order"
            required={orderRequired}
            part={planned.part}
            siteId={planned.site?.id}
            value={order.id}
            current={order.item ? { id: order.id, orderNumber: order.item.name } : undefined}
            onChange={(id, item) => setOrder({ id: id ?? null, item: item ?? null })}
          />
        )}
        {planOk && needsQty && (
          <Field
            label="Quantity (parts)"
            required
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            maxLength={9}
            error={quantity.trim() && !qtyValid ? "Enter a whole number of parts" : undefined}
            hint="Needed because some checks are sampled every N parts"
          />
        )}
        {planOk && p?.site && <p className="text-sm text-secondary-text">{p.site.name}. Work order and quantity can be filled in on the next screen.</p>}
        {p?.siteProblem && (
          <p role="alert" className="text-sm text-error-color">
            {p.siteProblem}
          </p>
        )}
        {single.error && <FormError error={single.error} />}
        {preview.error && <FormError error={preview.error} />}
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={buttonClass.primary} disabled={!ready || mutation.isPending}>
            {mutation.isPending ? "Starting…" : "Start job"}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

export default StartJobDialog;
