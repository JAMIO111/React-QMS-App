import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Dialog from "../ui/Dialog";
import RHFComboBox from "../ui/RHFComboBox";
import ReasonDialog from "../ncr/ReasonDialog";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCapaMutation, useCapas, useNcrCapas } from "../../hooks/useCapa";
import { capaHref, stepOf } from "../../lib/capa";
import { FormError } from "../master-data/shared";
import { StagePill, StepProgress } from "./shared";
import CTAButton from "@/components/CTAButton";

const LinkExistingDialog = ({ ncr, linkedIds, onClose }) => {
  const mutation = useCapaMutation();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(null);
  const running = useCapas({ stage: "running", q });
  const options = (running.data?.data ?? []).filter((c) => !linkedIds.has(c.id)).map((c) => ({ id: c.id, name: `${c.reference} · ${c.title}`, hint: stepOf(c.currentStep).code }));
  return (
    <Dialog title="Link to an existing 8D" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (picked) mutation.mutate({ action: "linkNcr", id: picked, body: { ncrId: ncr.id } }, { onSuccess: onClose }); }}>
        <p className="text-sm text-secondary-text">{ncr.reference} will be addressed by this 8D together with any other non-conformances linked to it. Only running 8Ds are listed.</p>
        <RHFComboBox label="8D" required value={picked} onChange={setPicked} options={options} placeholder="Search by number or title…" filterLocally={false} onSearchChange={setQ}
          emptyMessage={running.isFetching ? "Searching…" : "No running 8D matches"} sort={false} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!picked || mutation.isPending} loading={mutation.isPending}>{mutation.isPending ? "Linking…" : "Link"}</CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/**
 * The Investigation card on the NC page: the 8Ds this non-conformance is part of, and the two ways to add one: start a new 8D from this
 * non-conformance (prefilled and linked) or link it to an existing running 8D. One 8D can address many NCs.
 */
const NcrCapaCard = ({ ncr }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const mutation = useCapaMutation();
  const capas = useNcrCapas(ncr.id, { enabled: can("capa.read") });
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(null);
  if (!can("capa.read")) return null;
  const manage = can("capa.manage") && ncr.stage !== "cancelled" && !ncr.deletedAt;
  const list = capas.data ?? [];
  const start = () => mutation.mutate({ action: "create", body: { fromNcrId: ncr.id } }, { onSuccess: (capa) => navigate(`/CAPA/${capa.id}/d0`) });
  const buttons = (
    <div className="flex flex-wrap gap-3">
      <CTAButton buttonType="button" type="main" size="lg" disabled={mutation.isPending} loading={mutation.isPending} onClick={start}>{list.length ? "Start another 8D" : "Start a new 8D"}</CTAButton>
      <CTAButton buttonType="button" type="neutral" size="md" onClick={() => { mutation.reset(); setLinking(true); }}>Link to an existing 8D</CTAButton>
    </div>
  );

  return (
    <section className="flex flex-col gap-3 border-t border-border-color pt-5" aria-label="8D investigation">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-xl font-semibold text-primary-text">8D investigation</h3>
        <p className="text-sm text-secondary-text">A structured root-cause investigation for this non-conformance.</p>
      </div>
      {capas.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-secondary-text">No 8D addresses this non-conformance yet.</p>
          {manage ? buttons : <p className="text-sm text-secondary-text">You can read 8Ds but not start them.</p>}
        </div>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-color rounded-lg border border-border-color" aria-label="8Ds for this non-conformance">
            {list.map((c) => (
              <li key={c.linkId} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div className="flex min-w-0 flex-col">
                  <Link to={capaHref({ id: c.capaId, currentStep: c.currentStep })} className="font-medium text-link-color hover:underline">{c.reference}</Link>
                  <span className="truncate text-primary-text">{c.title}</span>
                </div>
                <div className="flex items-center gap-3">
                  <StagePill stage={c.stage} />
                  <StepProgress done={c.stepsDone} current={c.stage === "closed" || c.stage === "cancelled" ? null : c.currentStep} />
                  {manage && <CTAButton buttonType="button" type="neutral" size="md" aria-label={`Unlink ${c.reference}`} onClick={() => { mutation.reset(); setUnlinking(c); }}>Unlink</CTAButton>}
                </div>
              </li>
            ))}
          </ul>
          {manage && buttons}
        </>
      )}
      <FormError error={linking || unlinking ? null : mutation.error} />
      {linking && <LinkExistingDialog ncr={ncr} linkedIds={new Set(list.map((c) => c.capaId))} onClose={() => setLinking(false)} />}
      {unlinking && (
        <ReasonDialog
          title={`Unlink ${unlinking.reference}?`}
          label={`Why is ${ncr.reference} no longer part of this 8D?`}
          confirmText="Unlink"
          pending={mutation.isPending}
          error={mutation.error}
          onClose={() => setUnlinking(null)}
          onConfirm={(reason) => mutation.mutate({ action: "unlinkNcr", id: unlinking.linkId, body: { reason } }, { onSuccess: () => setUnlinking(null) })}
        />
      )}
    </section>
  );
};

export default NcrCapaCard;
