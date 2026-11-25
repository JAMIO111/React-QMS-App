import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ListTreeIcon, PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useFmeaDraft, useLinkedFmeas } from "../../hooks/useFmea";
import { fmeaPath, formatDay, kindLabel, originPath, originWords, statusLabel } from "../../lib/fmea";
import { ErrorNotice } from "../master-data/shared";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { FmeaDialog } from "./FmeaDialogs";

/** "Raised from non-conformance SNC-26-0011: …": where this FMEA came from, with a link when the caller may read the record. Never changes. */
export const RaisedFrom = ({ origin, prefix = "Raised from" }) => {
  if (!origin) return null;
  const path = originPath(origin.kind, origin.id);
  const words = `${originWords(origin.kind)}${origin.reference ? ` ${origin.reference}` : ""}`;
  return (
    <p className="text-sm text-secondary-text">
      {prefix}{" "}
      {origin.readable && path ? (
        <Link to={path} className="font-medium text-link-color hover:underline">
          {words}
        </Link>
      ) : (
        <span>a {originWords(origin.kind)} you cannot open</span>
      )}
      {origin.readable && origin.title ? `: ${origin.title}` : ""}
    </p>
  );
};

/** Fetches what the record suggests for an FMEA raised from it, then opens the usual dialog with it. */
const RaiseFromRecord = ({ kind, id, onClose }) => {
  const navigate = useNavigate();
  const draft = useFmeaDraft(kind, id);
  if (draft.isLoading)
    return (
      <Dialog title="Start an FMEA" onClose={onClose}>
        <p className="text-sm text-secondary-text">Preparing the FMEA…</p>
      </Dialog>
    );
  if (draft.error)
    return (
      <Dialog title="Start an FMEA" onClose={onClose}>
        <ErrorNotice error={draft.error} />
      </Dialog>
    );
  return <FmeaDialog draft={draft.data} onClose={onClose} onSaved={(f) => f?.id && navigate(fmeaPath(f.id))} />;
};

/**
 * "FMEAs" on the page of a non-conformance, 8D, audit finding, corrective action request or change: the FMEAs that were raised from this record and **Start an FMEA**, prefilled
 * with what the record says and keeping a link back to it (plan FM13). Shown only to people who may read FMEAs; the button only to those who may manage them. Information only.
 */
const RaisedFmeas = ({ kind, id, plain = false, title = "FMEAs raised from this" }) => {
  const { can } = usePermissions();
  const readable = can("fmea.read");
  const linked = useLinkedFmeas(kind, id, { enabled: readable });
  const [raising, setRaising] = useState(false);
  if (!readable || !id) return null;
  const data = linked.data;
  const body = linked.isLoading ? (
    <p className="text-sm text-secondary-text">Loading…</p>
  ) : linked.error ? (
    <ErrorNotice error={linked.error} />
  ) : !Array.isArray(data?.data) || data.data.length === 0 ? (
    <p className="text-sm text-secondary-text">No FMEA was raised from this {originWords(kind)} yet.</p>
  ) : (
    <ul aria-label="FMEAs raised from this record" className="-my-2 divide-y divide-border-color">
      {data.data.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-2 py-2">
          <Link to={fmeaPath(f.id)} className="text-sm font-medium text-primary-text hover:underline">
            {f.number}
          </Link>
          <span className="min-w-0 flex-1 truncate text-sm text-primary-text">{f.title}</span>
          <span className="text-xs text-secondary-text">{kindLabel(f.kind)}</span>
          <span className="text-xs text-secondary-text">{statusLabel(f.status ?? "active")}</span>
          {f.reviewOverdue && <span className="text-xs font-medium text-warning-color">Review overdue{f.nextReviewOn ? ` since ${formatDay(f.nextReviewOn)}` : ""}</span>}
        </li>
      ))}
    </ul>
  );
  const action = data?.canRaise && (
    <CTAButton type="secondary" icon={PlusIcon} onClick={() => setRaising(true)}>
      Start an FMEA
    </CTAButton>
  );
  return (
    <>
      {plain ? (
        <section aria-label={title} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-primary-text">
              <ListTreeIcon aria-hidden="true" /> {title}
            </h3>
            {action}
          </div>
          {body}
        </section>
      ) : (
        <MenuCard title={title} subtitle="Failure mode and effects analyses started because of this record." action={action}>
          {body}
        </MenuCard>
      )}
      {raising && <RaiseFromRecord kind={kind} id={id} onClose={() => setRaising(false)} />}
    </>
  );
};

export default RaisedFmeas;
