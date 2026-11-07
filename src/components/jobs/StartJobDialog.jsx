import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Dialog from "../ui/Dialog";
import Field from "../ui/Field";
import RHFComboBox from "../ui/RHFComboBox";
import { PartPicker } from "../ncr/Pickers";
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
 * Start a job: the operator chooses the machine and the part and nothing else. The site, start time and operator are filled in by the server;
 * the operation is asked only when the part's plan has several, and the quantity only when a check is sampled every N parts. If the work cannot be
 * inspected (no effective plan, no released revision …) the reasons are shown in the resolver's own words and Start stays off.
 */
const StartJobDialog = ({ onClose }) => {
  const navigate = useNavigate();
  const { organisationId } = useOrganisation();
  const remembered = lastMachine(organisationId);
  const [machineId, setMachineId] = useState(remembered?.id ?? null);
  const [search, setSearch] = useState("");
  const [part, setPart] = useState({ id: null, item: null });
  const [operation, setOperation] = useState(null);
  const [quantity, setQuantity] = useState("");
  const machines = useMachines({ q: useDebounced(search) });
  const mutation = useJobMutation();

  const options = (machines.data?.items ?? []).map((m) => ({ id: m.id, name: `${m.code} · ${m.name}` }));
  const current = remembered?.id === machineId ? { id: remembered.id, name: remembered.name } : undefined;
  const preview = useJobPreview({ machineId, partId: part.id, operationCode: operation ?? undefined });
  const p = preview.data;
  const settled = !!p && p.part.id === part.id && p.machine.id === machineId;
  const qtyValid = /^[1-9]\d{0,8}$/.test(quantity.trim());
  const ready = settled && p.status === "ok" && !!p.site && (!p.needsOperation || !!operation) && (!p.needsLotSize || qtyValid) && (!quantity.trim() || qtyValid);

  const start = (e) => {
    e.preventDefault();
    const machine = options.find((o) => o.id === machineId) ?? current;
    mutation.mutate(
      { machineId, partId: part.id, ...(operation ? { operationCode: operation } : p.operationCode ? { operationCode: p.operationCode } : {}), ...(quantity.trim() ? { lotSize: Number(quantity) } : {}) },
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
        <RHFComboBox
          label="Machine"
          required
          value={machineId}
          onChange={(id) => {
            setMachineId(id);
            setOperation(null);
          }}
          options={options}
          selectedOption={current}
          placeholder="Search machine code or name…"
          sort={false}
          filterLocally={false}
          onSearchChange={setSearch}
          emptyMessage={machines.isFetching ? "Searching…" : "No machines"}
        />
        <PartPicker
          label="Part number"
          required
          value={part.id}
          current={part.item}
          onChange={(id, item) => {
            setPart({ id: id ?? null, item: item ?? null });
            setOperation(null);
          }}
        />
        {settled && p.needsOperation && (
          <SelectField label="Operation" required placeholder="Choose the operation" value={operation} onChange={setOperation} options={p.operations.map((o) => ({ value: o.code, label: `${o.code} · ${o.name}` }))} />
        )}
        {settled && p.needsLotSize && (
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
        {settled && (
          <div aria-live="polite" className="flex flex-col gap-1 rounded-lg border border-border-color bg-secondary-bg p-3 text-sm">
            {p.status === "ok" ? (
              <>
                <p className="text-primary-text">
                  {p.site ? `${p.site.name}` : "No site"} · {p.plan ? `${p.plan.planCode} rev ${p.plan.revisionCode}` : "no plan"} · part rev {p.partRevision ?? "—"}
                </p>
                <p className="text-secondary-text">{p.requirementCount} checks to record. Work order and quantity can be filled in on the next screen.</p>
              </>
            ) : (
              <ul role="alert" className="list-disc pl-5 text-error-color">
                {p.problems.map((x) => (
                  <li key={x.code + x.message}>{x.message}</li>
                ))}
              </ul>
            )}
            {p.siteProblem && <p role="alert" className="text-error-color">{p.siteProblem}</p>}
          </div>
        )}
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
