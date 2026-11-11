import { Link } from "react-router-dom";
import { useMyDocuments, useWaitingReviews } from "../../hooks/useDocuments";
import { formatDay, revisionPath } from "../../lib/documents";
import { ErrorNotice } from "../master-data/shared";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";

const Row = ({ item, children }) => (
  <li className="flex flex-wrap items-center justify-between gap-2 py-2">
    <Link to={revisionPath(item.document.id, item.revision.id)} className="font-medium text-primary-text hover:underline">
      {item.document.number} rev {item.revision.letter} · {item.document.title}
    </Link>
    <span className="text-sm text-secondary-text">{children}</span>
  </li>
);

/** My documents (`/Documentation/My-Documents`): what the signed-in person has to read and acknowledge, reviews and approvals waiting for them, and what they read lately. */
const MyDocumentsPage = () => {
  const mine = useMyDocuments();
  const waiting = useWaitingReviews();

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header>
        <h1 className="text-2xl font-semibold text-primary-text">My documents</h1>
        <p className="text-sm text-secondary-text">Documents you have been asked to read, and revisions waiting for your review or approval.</p>
      </header>
      {mine.isLoading ? (
        <LoadingScreen />
      ) : mine.error ? (
        <ErrorNotice error={mine.error} />
      ) : (
        <>
          <MenuCard title="To read and acknowledge" subtitle={mine.data.toRead.length ? `${mine.data.toRead.length} waiting` : undefined}>
            {mine.data.toRead.length === 0 ? (
              <p className="text-sm text-secondary-text">Nothing to read. You are up to date.</p>
            ) : (
              <ul aria-label="To read" className="-my-2 divide-y divide-border-color">
                {mine.data.toRead.map((x) => (
                  <Row key={x.revision.id} item={x}>
                    {x.overdue ? <span className="font-medium text-error-color">Overdue since {formatDay(x.dueOn)}</span> : x.dueOn ? `By ${formatDay(x.dueOn)}` : "No deadline"}
                    {x.viewedAt ? " · opened" : ""}
                  </Row>
                ))}
              </ul>
            )}
          </MenuCard>

          <MenuCard title="Waiting for your review or approval">
            {(waiting.data ?? []).length === 0 ? (
              <p className="text-sm text-secondary-text">Nothing waiting for you.</p>
            ) : (
              <ul aria-label="Waiting for you" className="-my-2 divide-y divide-border-color">
                {waiting.data.map((w) => (
                  <Row key={w.revision.id} item={w}>
                    {w.role === "reviewer" ? "Review it" : "Approve it"} · since {formatDay(w.since)}
                    {w.author ? ` · by ${w.author}` : ""}
                  </Row>
                ))}
              </ul>
            )}
          </MenuCard>

          {mine.data.acknowledged.length > 0 && (
            <MenuCard title="Read lately" subtitle="Acknowledged in the last 90 days">
              <ul aria-label="Read lately" className="-my-2 divide-y divide-border-color">
                {mine.data.acknowledged.map((x) => (
                  <Row key={x.revision.id} item={x}>
                    Acknowledged {formatDay(x.acknowledgedAt)}
                  </Row>
                ))}
              </ul>
            </MenuCard>
          )}
        </>
      )}
    </div>
  );
};

export default MyDocumentsPage;
