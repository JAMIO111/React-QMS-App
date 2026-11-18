import { useState } from "react";
import Callout from "../ui/Callout";
import ComboField from "../ui/ComboField";
import Dialog from "../ui/Dialog";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import CommentThread from "./CommentThread";
import { useShareAcknowledgements, useShareComments, useShareMutation, useShares } from "../../hooks/usePortal";
import { describeApiError } from "../../lib/api-client";
import { partyKindLabel, shortDate, viewedWords } from "../../lib/portal";
import { useToast } from "../../contexts/ToastProvider";

const RECORD_WORDS = { ncr: "non-conformance", capa: "8D", document: "document", quality_alert: "quality alert" };
const SHOWS = {
  ncr: "They see the facts, containment and decisions (never costs or internal notes) and can reply here.",
  capa: "They see the facts, containment and decisions (never costs or internal notes) and can reply here.",
  document: "They read the revision in force (and open its files), can acknowledge it, and reply here. A new revision asks them again.",
  quality_alert: "They see what happened and what is asked of them (never departments, machines or who is on the list), can acknowledge it, and reply here.",
};
const ACKNOWLEDGED = new Set(["document", "quality_alert"]);

/**
 * "Shared with suppliers and customers" on a non-conformance or an 8D (docs/external-portal-plan.md PT2): who it is shared with, whether and when they
 * have looked, the conversation, and sharing with a party the record names. Renders nothing when there is nobody to share with and nothing shared,
 * so a record with no supplier or customer shows no card. Give it `Heading` and `Card` to sit in a page's own section layout.
 */
export default function PortalShareCard({ kind, recordId, Heading, Card }) {
  const shares = useShares(kind, recordId);
  const mutate = useShareMutation(kind, recordId);
  const { showToast } = useToast();
  const [talk, setTalk] = useState(null); // a share whose conversation is open
  const [stop, setStop] = useState(null); // a share being withdrawn
  const [reason, setReason] = useState("");
  const [party, setParty] = useState(null);
  const [who, setWho] = useState(null); // a share whose acknowledgements are open

  if (shares.isLoading || shares.error) return null;
  const { data: list = [], eligible = [] } = shares.data ?? {};
  if (list.length === 0 && eligible.length === 0) return null;
  const live = list.filter((s) => !s.withdrawnAt);
  const past = list.filter((s) => s.withdrawnAt);
  const word = RECORD_WORDS[kind];

  const share = () =>
    mutate.mutate(
      { action: "share", body: { partyId: party } },
      {
        onSuccess: (res) => {
          setParty(null);
          showToast({ type: "success", title: "Shared", message: res.email?.sent ? "Their people have been emailed." : "They will see it on their portal." });
        },
        onError: (error) => showToast({ type: "error", title: "Not shared", message: describeApiError(error) }),
      },
    );

  const body = (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-secondary-text">
        Share this {word} with a supplier or customer{ACKNOWLEDGED.has(kind) ? "" : " it names"}. {SHOWS[kind]}
      </p>
      {live.length === 0 ? (
        <p className="text-sm text-secondary-text">Not shared with anyone yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color" aria-label="Shared with">
          {live.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <div className="min-w-0 grow">
                <p className="truncate font-medium text-primary-text">{s.partyName} <span className="font-normal text-secondary-text">· {partyKindLabel(s.partyKind)}</span></p>
                <p className="text-xs text-secondary-text">
                  Shared {shortDate(s.sharedAt)}{s.sharedBy ? ` by ${s.sharedBy}` : ""} · {viewedWords(s)} · {s.comments} {s.comments === 1 ? "comment" : "comments"}
                  {s.externalComments > 0 ? ` (${s.externalComments} from them)` : ""}
                  {s.acknowledgement ? ` · Acknowledged by ${s.acknowledgement.acknowledged} of ${s.acknowledgement.people} (${s.acknowledgement.subject})` : ""}
                </p>
              </div>
              {s.acknowledgement && <CTAButton type="neutral" size="default" aria-label={`Who at ${s.partyName} acknowledged`} onClick={() => setWho(s)}>Who</CTAButton>}
              <CTAButton type="neutral" size="default" aria-label={`Conversation with ${s.partyName}`} onClick={() => setTalk(s)}>Conversation</CTAButton>
              <CTAButton type="neutral" size="default" aria-label={`Stop sharing with ${s.partyName}`} onClick={() => { setReason(""); setStop(s); }}>Stop sharing</CTAButton>
            </li>
          ))}
        </ul>
      )}
      {eligible.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-60 grow">
            <ComboField label="Share with" value={party} onChange={setParty} placeholder="Choose a supplier or customer"
              options={eligible.map((e) => ({ value: e.partyId, label: e.partyName, hint: partyKindLabel(e.partyKind) }))} />
          </div>
          <CTAButton type="main" size="md" disabled={!party} loading={mutate.isPending && mutate.variables?.action === "share"} onClick={share}>Share</CTAButton>
        </div>
      )}
      {past.length > 0 && (
        <details className="text-sm text-secondary-text">
          <summary className="cursor-pointer">Earlier shares ({past.length})</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {past.map((s) => (
              <li key={s.id}>{s.partyName}: shared {shortDate(s.sharedAt)}, stopped {shortDate(s.withdrawnAt)} ({s.withdrawnReason})
                <button type="button" className="ml-2 text-link-color hover:underline" onClick={() => setTalk(s)}>Conversation</button></li>
            ))}
          </ul>
        </details>
      )}
      {who && <AcknowledgementsDialog share={who} onClose={() => setWho(null)} />}
      {talk && <ConversationDialog share={talk} kind={kind} recordId={recordId} onClose={() => setTalk(null)} />}
      {stop && (
        <Dialog title={`Stop sharing with ${stop.partyName}?`} onClose={() => setStop(null)}>
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              mutate.mutate({ action: "withdraw", id: stop.id, body: { reason } }, { onSuccess: () => setStop(null), onError: (error) => showToast({ type: "error", title: "Not changed", message: describeApiError(error) }) });
            }}>
            <Callout tone="warning">They stop seeing it at once. The conversation is kept for you.</Callout>
            <TextAreaField label="Reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex justify-end gap-2">
              <CTAButton type="neutral" size="md" onClick={() => setStop(null)}>Cancel</CTAButton>
              <CTAButton type="danger" size="md" buttonType="submit" disabled={reason.trim().length < 3} loading={mutate.isPending}>Stop sharing</CTAButton>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );

  if (Heading && Card) {
    return (
      <>
        <Heading id={`${kind}-portal`} title="Shared with suppliers and customers" />
        <Card>{body}</Card>
      </>
    );
  }
  return <section aria-label="Shared with suppliers and customers" className="rounded-2xl border border-border-color bg-secondary-bg p-5">{body}</section>;
}

function ConversationDialog({ share, kind, recordId, onClose }) {
  const thread = useShareComments(share.id);
  const mutate = useShareMutation(kind, recordId);
  return (
    <Dialog title={`Conversation with ${share.partyName}`} onClose={onClose} width="max-w-2xl">
      {share.withdrawnAt && <Callout tone="info">This is no longer shared, so nothing more can be added.</Callout>}
      <CommentThread
        comments={thread.data?.data ?? []}
        readOnly={Boolean(share.withdrawnAt)}
        sending={mutate.isPending && mutate.variables?.action === "comment"}
        error={thread.error}
        onSend={(body) => mutate.mutateAsync({ action: "comment", id: share.id, shareId: share.id, body: { body } })}
        onWithdraw={(c) => mutate.mutate({ action: "withdrawComment", id: c.id, shareId: share.id })}
      />
    </Dialog>
  );
}

function AcknowledgementsDialog({ share, onClose }) {
  const list = useShareAcknowledgements(share.id);
  const rows = list.data?.data ?? [];
  return (
    <Dialog title={`Acknowledged by ${share.partyName}`} onClose={onClose} width="max-w-2xl">
      {list.isLoading ? (
        <p className="text-sm text-secondary-text">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-secondary-text">Nobody has acknowledged it yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-color rounded-xl border border-border-color" aria-label="Acknowledgements">
          {rows.map((k, i) => (
            <li key={i} className="px-4 py-2 text-sm">
              <p className="font-medium text-primary-text">{k.person} <span className="font-normal text-secondary-text">· {shortDate(k.acknowledgedAt)}</span></p>
              <p className="text-xs text-secondary-text">{k.subject}{k.current ? "" : " (an earlier revision)"}</p>
              {k.note && <p className="mt-1 text-secondary-text">“{k.note}”</p>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
