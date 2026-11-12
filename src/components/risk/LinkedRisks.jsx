import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon, ShieldAlertIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useLinkedRisks, useRiskDraft } from "../../hooks/useRisk";
import { BAND_PILL, bandLabel, reviewWords, riskPath, statusLabel, statusPill } from "../../lib/risk";
import { ErrorNotice } from "../master-data/shared";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { RiskDialog } from "./RiskDialogs";

const RAISABLE = ["ncr", "capa", "audit_finding"];

/** Fetches the suggestion for a risk raised from this record, then opens the usual raise dialog with it. */
const RaiseFromRecord = ({ kind, id, onClose }) => {
  const navigate = useNavigate();
  const draft = useRiskDraft(kind, id);
  if (draft.isLoading)
    return (
      <Dialog title="Raise a risk" onClose={onClose}>
        <p className="text-sm text-secondary-text">Preparing the risk…</p>
      </Dialog>
    );
  if (draft.error)
    return (
      <Dialog title="Raise a risk" onClose={onClose}>
        <ErrorNotice error={draft.error} />
      </Dialog>
    );
  return <RiskDialog draft={draft.data} onClose={onClose} onSaved={(r) => r?.id && navigate(riskPath(r.id))} />;
};

/** The risks linked to one record, with their level and status; read only. */
export const LinkedRiskList = ({ risks }) => (
  <ul aria-label="Linked risks" className="-my-2 divide-y divide-border-color">
    {risks.map((r) => (
      <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
        <Link to={riskPath(r.id)} className="text-sm font-medium text-primary-text hover:underline">
          {r.reference}
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm text-primary-text">{r.title}</span>
        {r.band ? (
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${BAND_PILL[r.band]}`}>{bandLabel(r.band)}</span>
        ) : (
          <span className="text-xs text-secondary-text">Not assessed</span>
        )}
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusPill(r.status)}`}>{statusLabel(r.status)}</span>
        {r.reviewOverdue && <span className="text-xs font-medium text-error-color">{reviewWords(r)}</span>}
      </li>
    ))}
  </ul>
);

/**
 * "Risks" on a record's page: the risks linked to it, and Raise a risk (prefilled, the record linked) on a non-conformance, an 8D or an audit finding.
 * Shown only to people who may read risks. `plain` drops the card frame (inside a page's own card or a dialog).
 */
const LinkedRisks = ({ kind, id, plain = false, title = "Risks" }) => {
  const { can } = usePermissions();
  const readable = can("risk.read");
  const linked = useLinkedRisks(kind, id, { enabled: readable });
  const [raising, setRaising] = useState(false);
  if (!readable || !id) return null;
  const data = linked.data;
  const canRaise = RAISABLE.includes(kind) && data?.canRaise;
  const body = linked.isLoading ? (
    <p className="text-sm text-secondary-text">Loading…</p>
  ) : linked.error ? (
    <ErrorNotice error={linked.error} />
  ) : data.data.length === 0 ? (
    <p className="text-sm text-secondary-text">No risk is linked to this yet.</p>
  ) : (
    <LinkedRiskList risks={data.data} />
  );
  const action = canRaise && (
    <CTAButton type="secondary" icon={PlusIcon} onClick={() => setRaising(true)}>
      Raise a risk
    </CTAButton>
  );
  return (
    <>
      {plain ? (
        <section aria-label={title} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-primary-text">
              <ShieldAlertIcon aria-hidden="true" /> {title}
            </h3>
            {action}
          </div>
          {body}
        </section>
      ) : (
        <MenuCard title={title} subtitle="Risks and opportunities in the register that name this record." action={action}>
          {body}
        </MenuCard>
      )}
      {raising && <RaiseFromRecord kind={kind} id={id} onClose={() => setRaising(false)} />}
    </>
  );
};

export default LinkedRisks;
