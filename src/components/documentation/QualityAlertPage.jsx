import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useAlertMutation, useQualityAlert } from "../../hooks/useDocumentation";
import { formatDateTime } from "../../lib/processControl";
import { categoryLabel, formatDay, referenceText, statusOf } from "../../lib/qualityAlerts";
import { ErrorNotice, FormError, TextAreaField, buttonClass } from "../master-data/shared";
import { SeverityBadge, StatusPill } from "./shared";

const Facts = ({ items }) => (
  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
    {items.map(([k, v]) => (
      <div key={k}>
        <dt className="text-secondary-text">{k}</dt>
        <dd className="text-primary-text">{v}</dd>
      </div>
    ))}
  </dl>
);

const List = ({ items, empty }) =>
  items.length === 0 ? (
    <p className="text-sm text-secondary-text">{empty}</p>
  ) : (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((x) => (
        <li key={x.key} className="rounded-full border border-border-color px-2 py-0.5 text-sm text-primary-text">
          {x.label}
        </li>
      ))}
    </ul>
  );

/** Asks for a reason, then withdraws or revises. */
const ReasonDialog = ({ title, intro, confirmText, action, alert, onClose, onDone }) => {
  const mutation = useAlertMutation();
  const [reason, setReason] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ action, id: alert.id, body: { reason } }, { onSuccess: (data) => (onClose(), onDone?.(data)) });
        }}>
        <p className="text-sm text-primary-text">{intro}</p>
        <TextAreaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass.neutral} onClick={onClose}>Cancel</button>
          <button type="submit" className={buttonClass.primary} disabled={!reason.trim() || mutation.isPending}>
            {mutation.isPending ? "Saving…" : confirmText}
          </button>
        </div>
      </form>
    </Dialog>
  );
};

/** One quality alert revision: what it says, what it affects, who must act, and the actions for its lifecycle state. */
const QualityAlertPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can } = usePermissions();
  const query = useQualityAlert(id);
  const mutation = useAlertMutation();
  const [dialog, setDialog] = useState(null); // "withdraw" | "revise"
  const a = query.data;

  if (query.isLoading) return <p className="p-4 text-secondary-text">Loading…</p>;
  if (query.error) return <div className="p-4"><ErrorNotice error={query.error} /></div>;

  const manage = can("documentation.manage");
  const issue = can("documentation.issue");
  const isDraft = a.status === "draft";
  const current = a.status === "active" || a.status === "expired";

  const doIssue = async () => {
    const ok = await confirm({
      title: `Issue ${referenceText(a)}?`,
      message: "Once issued, the content is frozen: a correction needs a new revision. The people it is addressed to will be asked to acknowledge it.",
      confirmText: "Issue alert",
      cancelText: "Cancel",
      type: "warning",
    });
    if (ok) mutation.mutate({ action: "issue", id: a.id });
  };
  const doDiscard = async () => {
    const ok = await confirm({ title: "Discard this draft?", message: "The draft is removed from the register.", confirmText: "Discard", cancelText: "Keep", type: "warning" });
    if (ok) mutation.mutate({ action: "discard", id: a.id }, { onSuccess: () => navigate("/Documentation/Quality-Alerts") });
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-secondary-text">
            <Link to="/Documentation/Quality-Alerts" className="text-link-color hover:underline">Quality alerts</Link> · {referenceText(a)}
          </p>
          <h1 className="text-2xl font-semibold text-primary-text">{a.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <SeverityBadge severity={a.severity} />
            <StatusPill alert={a} />
            <span className="text-sm text-secondary-text">{categoryLabel(a.category)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {isDraft && manage && (
            <>
              <button type="button" className={buttonClass.neutral} onClick={() => navigate(`/Documentation/Quality-Alerts/${a.id}/edit`)}>Edit</button>
              <button type="button" className={buttonClass.neutral} disabled={mutation.isPending} onClick={doDiscard}>Discard</button>
            </>
          )}
          {isDraft && issue && (
            <button type="button" className={buttonClass.primary} disabled={mutation.isPending} onClick={doIssue}>Issue alert</button>
          )}
          {current && issue && (
            <>
              <button type="button" className={buttonClass.neutral} onClick={() => setDialog("revise")}>Issue a revision</button>
              <button type="button" className={buttonClass.danger} onClick={() => setDialog("withdraw")}>Withdraw</button>
            </>
          )}
        </div>
      </div>
      <FormError error={mutation.error} />

      {a.revisionReason && (
        <p className="rounded-lg border border-border-color p-3 text-sm text-primary-text">
          <span className="text-secondary-text">Why revision {a.revisionLetter}:</span> {a.revisionReason}
        </p>
      )}
      {a.withdrawn && (
        <p role="status" className="rounded-lg border border-error-color p-3 text-sm text-primary-text">
          Withdrawn {formatDateTime(a.withdrawn.at)}{a.withdrawn.by ? ` by ${a.withdrawn.by.name}` : ""}: {a.withdrawn.reason}
        </p>
      )}
      {a.status === "superseded" && (
        <p role="status" className="rounded-lg border border-border-color p-3 text-sm text-primary-text">
          A newer revision replaced this one. See the revisions below.
        </p>
      )}

      <MenuCard title="What happened and what to do">
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-medium text-secondary-text">Description</h2>
            <p className="whitespace-pre-wrap text-sm text-primary-text">{a.description ?? "Not written yet."}</p>
          </div>
          <div>
            <h2 className="text-sm font-medium text-secondary-text">Required action</h2>
            <p className="whitespace-pre-wrap text-sm text-primary-text">{a.requiredAction ?? "Not written yet."}</p>
          </div>
          <Facts
            items={[
              ["Effective", formatDay(a.effectiveDate)],
              ["Expires", formatDay(a.expiryDate)],
              ["Acknowledge by", formatDay(a.acknowledgeBy)],
              ["Issued", a.issuedAt ? `${formatDateTime(a.issuedAt)}${a.issuedBy ? ` by ${a.issuedBy.name}` : ""}` : "Not issued"],
            ]}
          />
        </div>
      </MenuCard>

      <MenuCard title="What it affects" subtitle="Products, processes and areas this alert applies to">
        <div className="flex flex-col gap-3">
          <div><h2 className="mb-1 text-sm font-medium text-secondary-text">Products</h2><List items={a.scope.parts.map((p) => ({ key: p.id, label: `${p.label}${p.kind === "family" ? " (family)" : ""}` }))} empty="No products named." /></div>
          <div><h2 className="mb-1 text-sm font-medium text-secondary-text">Machines</h2><List items={a.scope.machines.map((m) => ({ key: m.id, label: m.label }))} empty="No machines named." /></div>
          <div><h2 className="mb-1 text-sm font-medium text-secondary-text">Operations</h2><List items={a.scope.operations.map((o) => ({ key: o, label: o }))} empty="No operations named." /></div>
          <div><h2 className="mb-1 text-sm font-medium text-secondary-text">Departments</h2><List items={a.scope.departments.map((d) => ({ key: d.id, label: d.label }))} empty="No departments named." /></div>
        </div>
      </MenuCard>

      <MenuCard title="Who must acknowledge" subtitle="Everyone reached by these departments, roles and named people">
        <List items={a.scope.targets.map((t) => ({ key: t.id, label: `${t.label} (${t.kind})` }))} empty="Nobody chosen yet; an alert needs at least one before it can be issued." />
      </MenuCard>

      {a.revisions.length > 1 && (
        <MenuCard title="Revisions">
          <ul className="text-sm text-primary-text" aria-label="Revisions">
            {a.revisions.map((r) => (
              <li key={r.id} className="py-0.5">
                {r.id === a.id ? <strong>Revision {r.revisionLetter}</strong> : <Link to={`/Documentation/Quality-Alerts/${r.id}`} className="text-link-color hover:underline">Revision {r.revisionLetter}</Link>}
                {" · "}{statusOf(r.status).label}{r.issuedAt ? ` · issued ${formatDateTime(r.issuedAt)}` : ""}{r.revisionReason ? ` · ${r.revisionReason}` : ""}
              </li>
            ))}
          </ul>
        </MenuCard>
      )}

      {dialog === "withdraw" && (
        <ReasonDialog
          title={`Withdraw ${referenceText(a)}`}
          intro="The alert stays on record but no longer applies. Say why it is withdrawn."
          confirmText="Withdraw"
          action="withdraw"
          alert={a}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "revise" && (
        <ReasonDialog
          title={`Issue a revision of ${a.reference}`}
          intro="A draft copy is made for you to correct and issue. The current revision stays in force until the new one is issued, then it is superseded."
          confirmText="Create draft revision"
          action="revise"
          alert={a}
          onClose={() => setDialog(null)}
          onDone={(draft) => navigate(`/Documentation/Quality-Alerts/${draft.id}/edit`)}
        />
      )}
    </div>
  );
};

export default QualityAlertPage;
