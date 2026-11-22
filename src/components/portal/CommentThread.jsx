import { useState } from "react";
import Callout from "../ui/Callout";
import CTAButton from "@/components/CTAButton";
import { TextAreaField } from "../master-data/shared";
import { describeApiError } from "../../lib/api-client";
import { longDateTime } from "../../lib/portal";

/**
 * The conversation on a shared record, used by both sides (staff on the record's page, the party on the portal). Each comment shows who wrote it;
 * your own can be withdrawn within ten minutes (the server decides), and a withdrawn one keeps its place but not its words.
 */
export default function CommentThread({ comments, onSend, onWithdraw, sending, error, readOnly = false, label = "Conversation" }) {
  const [text, setText] = useState("");
  const [localError, setLocalError] = useState(null);

  const send = async (e) => {
    e.preventDefault();
    setLocalError(null);
    try {
      await onSend(text.trim());
      setText("");
    } catch (err) {
      setLocalError(err);
    }
  };

  return (
    <section aria-label={label} className="flex flex-col gap-3">
      {comments.length === 0 ? (
        <p className="text-sm text-secondary-text">Nothing has been said yet.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={`${label} so far`}>
          {comments.map((c) => (
            <li key={c.id} className={`flex flex-col gap-1 rounded-xl border px-3 py-2 ${c.side === "staff" ? "border-border-color bg-primary-bg" : "border-brand-primary/40 bg-brand-primary/5"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-secondary-text">
                <span className="font-medium text-primary-text">{c.author}</span>
                <span>{longDateTime(c.createdAt)}</span>
              </div>
              {c.withdrawn ? <p className="text-sm italic text-secondary-text">Comment withdrawn</p> : <p className="whitespace-pre-wrap break-words text-sm text-primary-text">{c.body}</p>}
              {c.canWithdraw && !readOnly && (
                <button type="button" className="w-fit text-xs text-link-color hover:underline" onClick={() => onWithdraw(c)}>
                  Withdraw (you can for ten minutes)
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form onSubmit={send} className="flex flex-col gap-2" noValidate aria-label="Write a comment">
          <TextAreaField label="Write a comment" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex justify-end">
            <CTAButton type="main" size="md" buttonType="submit" disabled={!text.trim()} loading={sending}>Send</CTAButton>
          </div>
        </form>
      )}
      {(localError || error) && <Callout tone="error" role="alert">{describeApiError(localError || error)}</Callout>}
    </section>
  );
}
