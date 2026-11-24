import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { GitPullRequestArrowIcon, PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useChangeDraft, useLinkedChanges } from "../../hooks/useChange";
import { changePath, stageLabel, stagePill, urgencyLabel, viaWords } from "../../lib/change";
import { ErrorNotice } from "../master-data/shared";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { ChangeDialog } from "./ChangeDialogs";

/** Fetches what a change raised from this record starts with, then opens the usual raise dialog with it. */
const RaiseFromRecord = ({ kind, id, onClose }) => {
  const navigate = useNavigate();
  const draft = useChangeDraft(kind, id);
  if (draft.isLoading)
    return (
      <Dialog title="Raise a change" onClose={onClose}>
        <p className="text-sm text-secondary-text">Preparing the change…</p>
      </Dialog>
    );
  if (draft.error)
    return (
      <Dialog title="Raise a change" onClose={onClose}>
        <ErrorNotice error={draft.error} />
      </Dialog>
    );
  return <ChangeDialog draft={draft.data} onClose={onClose} onSaved={(c) => c?.id && navigate(changePath(c.id))} />;
};

/** A button on a row (an 8D action, a review decision, an accepted document request) that raises a change from it; shown only to people who may manage changes. */
export const RaiseChangeButton = ({ kind, id, label = "Raise a change", ariaLabel }) => {
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  if (!can("change.manage") || !id) return null;
  return (
    <>
      <CTAButton buttonType="button" type="neutral" size="md" icon={GitPullRequestArrowIcon} aria-label={ariaLabel} onClick={() => setOpen(true)}>
        {label}
      </CTAButton>
      {open && <RaiseFromRecord kind={kind} id={id} onClose={() => setOpen(false)} />}
    </>
  );
};

/** The changes that name one record, with their stage and how they relate to it; read only. */
export const LinkedChangeList = ({ changes }) => (
  <ul aria-label="Linked changes" className="-my-2 divide-y divide-border-color">
    {changes.map((c) => (
      <li key={c.id} className="flex flex-wrap items-center gap-2 py-2">
        <Link to={changePath(c.id)} className="text-sm font-medium text-primary-text hover:underline">
          {c.reference}
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm text-primary-text">{c.title}</span>
        {c.urgency === "expedited" && <span className="text-xs font-medium text-warning-color">{urgencyLabel(c.urgency)}</span>}
        <span className="text-xs text-secondary-text">{viaWords(c.via)}</span>
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stagePill(c.stage)}`}>{stageLabel(c.stage)}</span>
      </li>
    ))}
  </ul>
);

/**
 * "Changes" on a record's page: the engineering changes raised from it, covering it or with a task on it, and Raise a change (prefilled, the record
 * kept as its origin) where the record can be one. Shown only to people who may read changes. `plain` drops the card frame.
 */
const LinkedChanges = ({ kind, id, plain = false, title = "Changes" }) => {
  const { can } = usePermissions();
  const readable = can("change.read");
  const linked = useLinkedChanges(kind, id, { enabled: readable });
  const [raising, setRaising] = useState(false);
  if (!readable || !id) return null;
  const data = linked.data;
  const body = linked.isLoading ? (
    <p className="text-sm text-secondary-text">Loading…</p>
  ) : linked.error ? (
    <ErrorNotice error={linked.error} />
  ) : data.data.length === 0 ? (
    <p className="text-sm text-secondary-text">No change names this yet.</p>
  ) : (
    <LinkedChangeList changes={data.data} />
  );
  const action = data?.canRaise && (
    <CTAButton type="secondary" icon={PlusIcon} onClick={() => setRaising(true)}>
      Raise a change
    </CTAButton>
  );
  return (
    <>
      {plain ? (
        <section aria-label={title} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-primary-text">
              <GitPullRequestArrowIcon aria-hidden="true" /> {title}
            </h3>
            {action}
          </div>
          {body}
        </section>
      ) : (
        <MenuCard title={title} subtitle="Engineering changes (ECR / ECN) that name this record." action={action}>
          {body}
        </MenuCard>
      )}
      {raising && <RaiseFromRecord kind={kind} id={id} onClose={() => setRaising(false)} />}
    </>
  );
};

export default LinkedChanges;
