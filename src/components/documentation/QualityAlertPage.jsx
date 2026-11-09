import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Dialog from "../ui/Dialog";
import MenuCard from "../ui/MenuCard";
import Callout from "../ui/Callout";
import RHFDatePickerPopout from "../ui/RHFDatePickerPopout";
import { useConfirm } from "../../contexts/ConfirmationModalProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useMembers } from "../../hooks/useQmsApi";
import { useAlertMutation, useQualityAlert, useRecipients, useRecipientsPreview } from "../../hooks/useDocumentation";
import { formatDateTime } from "../../lib/processControl";
import { categoryLabel, formatDay, referenceText, statusOf } from "../../lib/qualityAlerts";
import { ErrorNotice, FormError, TextAreaField } from "../master-data/shared";
import { AcknowledgeDialog } from "./Acknowledge";
import { ActionsList, SeverityBadge, StatusPill } from "./shared";
import AlertFiles from "./AlertFiles";
import { LinkList } from "./AlertLinks";
import CTAButton from "@/components/CTAButton";

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
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!reason.trim() || mutation.isPending}>
            {mutation.isPending ? "Saving…" : confirmText}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** An expired alert back in force: a new expiry date (today or later) and why; both the old and the new date are kept in the history. */
const ReopenDialog = ({ alert, onClose }) => {
  const mutation = useAlertMutation();
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Dialog title={`Reopen ${referenceText(alert)}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ action: "reopen", id: alert.id, body: { expiryDate: expiry, reason: reason.trim() } }, { onSuccess: onClose });
        }}>
        <p className="text-sm text-primary-text">
          The alert expired on {formatDay(alert.expiryDate)}. Reopening puts it back in force with a new expiry date. The change is recorded in its history.
        </p>
        <RHFDatePickerPopout label="New expiry date" required valueFormat="iso" minDate={today} value={expiry} onChange={(v) => setExpiry(v ?? "")} placeholder="Select a date" />
        <TextAreaField label="Why is it being reopened?" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} rows={3} />
        <FormError error={mutation.error} />
        <div className="flex justify-end gap-2">
          <CTAButton buttonType="button" type="neutral" size="md" onClick={onClose}>Cancel</CTAButton>
          <CTAButton buttonType="submit" type="main" size="lg" disabled={!expiry || !reason.trim() || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Reopen alert"}
          </CTAButton>
        </div>
      </form>
    </Dialog>
  );
};

/** When the alert expired or was reopened, by whom, and the old and new expiry dates. */
const History = ({ history }) => (
  <MenuCard title="Expiry history" subtitle="Every expiry and reopening of this revision">
    <ol className="flex flex-col gap-2" aria-label="Expiry history">
      {history.map((h) => (
        <li key={h.id} className="text-sm text-primary-text">
          <span className="font-medium">{h.kind === "expired" ? "Expired" : "Reopened"}</span> · {formatDateTime(h.at)}
          {h.kind === "reopened" && h.by ? ` · ${h.by.name}` : h.kind === "expired" ? " · automatically" : ""}
          <span className="block text-secondary-text">
            {h.kind === "expired" ? `Its expiry date was ${formatDay(h.previousExpiry)}.` : `Expiry moved from ${formatDay(h.previousExpiry)} to ${formatDay(h.newExpiry)}: ${h.reason}`}
          </span>
        </li>
      ))}
    </ol>
  </MenuCard>
);

/** Before issuing: how many people each target reaches, and a warning when somebody chosen reaches nobody. */
const RecipientsPreview = ({ id }) => {
  const query = useRecipientsPreview(id);
  const p = query.data;
  return (
    <MenuCard title="Who will be asked" subtitle="Worked out when the alert is issued, then fixed as the record of who was asked">
      {query.isLoading && <p className="text-sm text-secondary-text">Working out…</p>}
      {query.error && <ErrorNotice error={query.error} />}
      {p && (
        <div className="flex flex-col gap-2 text-sm text-primary-text">
          <p>
            {p.total === 0 ? (
              <span className="text-error-color">Nobody active is reached yet, so this alert cannot be issued.</span>
            ) : (
              <>
                <strong>{p.total}</strong> {p.total === 1 ? "person" : "people"} will be asked to acknowledge it.
              </>
            )}
          </p>
          <ul className="flex flex-wrap gap-1.5" aria-label="People reached by each target">
            {p.targets.map((t) => (
              <li key={t.id} className={`rounded-full border px-2 py-0.5 ${t.count === 0 ? "border-error-color text-error-color" : "border-border-color"}`}>
                {t.label} ({t.kind}): {t.count === 0 ? "nobody" : t.count}
              </li>
            ))}
          </ul>
        </div>
      )}
    </MenuCard>
  );
};

const RECIPIENT_FILTERS = [
  { value: "all", label: "Everyone" },
  { value: "open", label: "Not acknowledged" },
  { value: "done", label: "Acknowledged" },
];

/** For managers: who was asked, who has seen it, who has acknowledged it, who is overdue; and adding a person later. */
const Tracking = ({ alert, canAdd }) => {
  const query = useRecipients(alert.id);
  const mutation = useAlertMutation();
  const { can } = usePermissions();
  const members = useMembers({ enabled: canAdd && can("members.read") });
  const [filter, setFilter] = useState("all");
  const [department, setDepartment] = useState("");
  const [person, setPerson] = useState("");
  const rows = query.data?.data ?? [];
  const totals = query.data?.totals;
  const departments = [...new Set(rows.flatMap((r) => r.reachedVia.filter((v) => v.startsWith("Department: ")).map((v) => v.slice(12))))].sort();
  const shown = rows
    .filter((r) => (filter === "open" ? !r.acknowledgedAt : filter === "done" ? !!r.acknowledgedAt : true))
    .filter((r) => !department || r.reachedVia.includes(`Department: ${department}`));
  const asked = new Set(rows.map((r) => r.membershipId));
  const candidates = (members.data?.data ?? []).filter((m) => m.status === "active" && m.userId && !asked.has(m.membershipId));

  return (
    <MenuCard title="Acknowledgements" subtitle="Evidence that the alert reached the people it was addressed to">
      <div className="flex flex-col gap-3">
        {query.isLoading && <p className="text-sm text-secondary-text">Loading…</p>}
        {query.error && <ErrorNotice error={query.error} />}
        {totals && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" aria-label="Acknowledgement totals">
            <div><dt className="text-secondary-text">Asked</dt><dd className="tabular-nums text-primary-text">{totals.total}</dd></div>
            <div><dt className="text-secondary-text">Viewed</dt><dd className="tabular-nums text-primary-text">{totals.viewed} of {totals.total}</dd></div>
            <div><dt className="text-secondary-text">Acknowledged</dt><dd className="tabular-nums text-primary-text">{totals.acknowledged} of {totals.total}</dd></div>
            <div><dt className="text-secondary-text">Overdue</dt><dd className={`tabular-nums ${totals.overdue ? "font-medium text-error-color" : "text-primary-text"}`}>{totals.overdue}</dd></div>
          </dl>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text">
            Show
            <select aria-label="Show" className="h-9.5 rounded-lg border border-border-color bg-text-input-color px-2 py-2 text-sm text-primary-text" value={filter} onChange={(e) => setFilter(e.target.value)}>
              {RECIPIENT_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          {departments.length > 0 && (
            <label className="flex flex-col gap-1 text-sm font-medium text-secondary-text">
              Department
              <select aria-label="Department" className="h-9.5 rounded-lg border border-border-color bg-text-input-color px-2 py-2 text-sm text-primary-text" value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">All</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}
          {canAdd && candidates.length > 0 && (
            <form
              className="ml-auto flex items-end gap-2"
              aria-label="Add a person"
              onSubmit={(e) => {
                e.preventDefault();
                if (person) mutation.mutate({ action: "addRecipient", id: alert.id, body: { membershipId: person } }, { onSuccess: () => setPerson("") });
              }}>
              <select aria-label="Person to add" className="h-9.5 rounded-lg border border-border-color bg-text-input-color px-2 py-2 text-sm text-primary-text" value={person} onChange={(e) => setPerson(e.target.value)}>
                <option value="">Add a person…</option>
                {candidates.map((m) => <option key={m.membershipId} value={m.membershipId}>{[m.firstName, m.surname].filter(Boolean).join(" ") || m.email}</option>)}
              </select>
              <CTAButton buttonType="submit" type="neutral" size="md" disabled={!person || mutation.isPending}>Add</CTAButton>
            </form>
          )}
        </div>
        <FormError error={mutation.error} />
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm text-primary-text" aria-label="Recipients">
              <thead>
                <tr>
                  {["Person", "Reached through", "Viewed", "Acknowledged"].map((h) => (
                    <th key={h} scope="col" className="border-b border-border-color px-2 py-2 text-left font-normal text-secondary-text">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <th scope="row" className="border-b border-border-color px-2 py-2 text-left font-normal">{r.name}</th>
                    <td className="border-b border-border-color px-2 py-2 text-secondary-text">{r.reachedVia.join(", ")}</td>
                    <td className="border-b border-border-color px-2 py-2">{r.firstViewedAt ? formatDateTime(r.firstViewedAt) : "Not yet"}</td>
                    <td className="border-b border-border-color px-2 py-2">
                      {r.acknowledgedAt ? (
                        <span>
                          {formatDateTime(r.acknowledgedAt)}
                          {r.note && <span className="block text-xs text-secondary-text">“{r.note}”</span>}
                        </span>
                      ) : r.overdue ? (
                        <span className="font-medium text-error-color">Overdue</span>
                      ) : (
                        "Not yet"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MenuCard>
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
  const [dialog, setDialog] = useState(null); // "withdraw" | "revise" | "acknowledge" | "reopen"
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
              <CTAButton buttonType="button" type="neutral" size="md" onClick={() => navigate(`/Documentation/Quality-Alerts/${a.id}/edit`)}>Edit</CTAButton>
              <CTAButton buttonType="button" type="neutral" size="md" disabled={mutation.isPending} onClick={doDiscard}>Discard</CTAButton>
            </>
          )}
          {isDraft && issue && (
            <CTAButton buttonType="button" type="main" size="lg" disabled={mutation.isPending} onClick={doIssue}>Issue alert</CTAButton>
          )}
          {current && issue && (
            <>
              {a.status === "expired" && <CTAButton buttonType="button" type="main" size="md" onClick={() => setDialog("reopen")}>Reopen</CTAButton>}
              <CTAButton buttonType="button" type="neutral" size="md" onClick={() => setDialog("revise")}>Issue a revision</CTAButton>
              <CTAButton buttonType="button" type="danger" size="md" onClick={() => setDialog("withdraw")}>Withdraw</CTAButton>
            </>
          )}
        </div>
      </div>
      <FormError error={mutation.error} />

      {a.me && a.status === "active" && !a.me.acknowledgedAt && (
        <Callout
          tone={a.me.overdue ? "error" : "warning"}
          role="status"
          title={a.me.overdue ? "Overdue: your acknowledgement is needed" : "Your acknowledgement is needed"}
          action={<CTAButton buttonType="button" type="main" size="lg" onClick={() => setDialog("acknowledge")}>Acknowledge</CTAButton>}>
          This alert is addressed to you{a.acknowledgeBy ? ` — please acknowledge it by ${formatDay(a.acknowledgeBy)}` : ""}. Read it, then confirm.
        </Callout>
      )}
      {a.me && a.me.acknowledgedAt && (
        <Callout tone="success" title="You have acknowledged this alert">
          On {formatDateTime(a.me.acknowledgedAt)}{a.me.note ? `: “${a.me.note}”` : "."}
        </Callout>
      )}
      {a.status === "expired" && (
        <Callout tone="warning" title="This alert has expired">
          It expired after {formatDay(a.expiryDate)} and no longer shows where people work.{issue ? " Reopen it with a new expiry date if it still applies." : ""}
        </Callout>
      )}
      {a.revisionReason && (
        <Callout tone="info" title={`Why revision ${a.revisionLetter}`}>
          {a.revisionReason}
        </Callout>
      )}
      {a.withdrawn && (
        <Callout tone="error" role="status" title="Withdrawn">
          {formatDateTime(a.withdrawn.at)}{a.withdrawn.by ? ` by ${a.withdrawn.by.name}` : ""}: {a.withdrawn.reason}
        </Callout>
      )}
      {a.status === "superseded" && (
        <Callout tone="info" role="status" title="Superseded">
          A newer revision replaced this one. See the revisions below.
        </Callout>
      )}

      <MenuCard title="What happened and what to do">
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-medium text-secondary-text">Description</h2>
            <p className="whitespace-pre-wrap text-sm text-primary-text">{a.description ?? "Not written yet."}</p>
          </div>
          <div>
            <h2 className="mb-1 text-sm font-medium text-secondary-text">Required actions</h2>
            <ActionsList actions={a.actions} />
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

      {a.links.length > 0 && (
        <MenuCard title="Related records" subtitle="What this alert refers to">
          <LinkList links={a.links} />
        </MenuCard>
      )}

      <MenuCard title="Files" subtitle={a.status === "draft" ? "Add files in the draft editor" : undefined}>
        <AlertFiles alertId={a.id} canEdit={false} />
      </MenuCard>

      <MenuCard title="Who must acknowledge" subtitle="Everyone reached by these departments, roles and named people">
        <List items={a.scope.targets.map((t) => ({ key: t.id, label: `${t.label} (${t.kind})` }))} empty="Nobody chosen yet; an alert needs at least one before it can be issued." />
      </MenuCard>

      {isDraft && manage && <RecipientsPreview id={a.id} />}
      {!isDraft && manage && <Tracking alert={a} canAdd={issue && a.status === "active"} />}

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

      {a.history?.length > 0 && <History history={a.history} />}
      {dialog === "acknowledge" && <AcknowledgeDialog alert={a} onClose={() => setDialog(null)} />}
      {dialog === "reopen" && <ReopenDialog alert={a} onClose={() => setDialog(null)} />}
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
