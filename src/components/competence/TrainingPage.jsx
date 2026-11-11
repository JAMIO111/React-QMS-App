import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useTrainingSessions } from "../../hooks/useCompetence";
import { useUrlFilters } from "../../hooks/useUrlFilters";
import { kindLabel, pillClass, providerLine, SESSION_STATUS, SESSION_STATUS_OPTIONS, sessionDates, sessionStatusLabel } from "../../lib/competence";
import { ErrorNotice, SearchBox } from "../master-data/shared";
import LoadingScreen from "../ui/LoadingScreen";
import SlidingToggle from "../ui/SlidingToggle";
import { SessionDialog } from "./SessionDialogs";

export const TRAINING_FILTER_KEYS = ["search", "status", "page"];

/** Training sessions (`/Competence/Training`): the register. Anyone who may read competence sees all; a person on a session sees the ones they are on. */
const TrainingPage = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const f = useUrlFilters(TRAINING_FILTER_KEYS);
  const [creating, setCreating] = useState(false);
  const page = Number(f.page) || 1;
  const sessions = useTrainingSessions({ q: f.search, status: f.status || undefined, page: f.page || undefined });

  return (
    <div className="flex w-full min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">Training sessions</h1>
          <p className="text-sm text-secondary-text">One session, a list of attendees, each completed on their own day.</p>
        </div>
        {can("competence.assess") && (
          <CTAButton buttonType="button" type="main" icon={PlusIcon} onClick={() => setCreating(true)}>
            New session
          </CTAButton>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <SearchBox label="Search sessions" onSearch={(v) => f.updateFilters({ search: v })} />
        <SlidingToggle ariaLabel="Status" options={SESSION_STATUS_OPTIONS} value={f.status || "all"} onChange={(v) => f.updateFilters({ status: v === "all" ? "" : v })} />
      </div>

      {sessions.isLoading ? (
        <LoadingScreen />
      ) : sessions.error ? (
        <ErrorNotice error={sessions.error} />
      ) : sessions.data.data.length === 0 ? (
        <p className="text-sm text-secondary-text">No training sessions {f.search || f.status ? "match" : "yet"}.</p>
      ) : (
        <div className="min-h-0 overflow-auto rounded-2xl border border-border-color bg-secondary-bg">
          <table className="min-w-full text-sm" aria-label="Training sessions">
            <thead>
              <tr className="border-b border-border-color text-left text-secondary-text">
                {["Reference", "Title", "Kind", "Dates", "Run by", "Attendees", "Status"].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sessions.data.data.map((s) => (
                <tr key={s.id} className="border-b border-border-color last:border-0 hover:bg-primary-text/5">
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link to={`/Competence/Training/${s.id}`} className="font-medium text-primary-text hover:underline">
                      {s.reference}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-primary-text">{s.title}</td>
                  <td className="px-3 py-2 text-secondary-text">{kindLabel(s.kind)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-secondary-text">{sessionDates(s)}</td>
                  <td className="px-3 py-2 text-secondary-text">{providerLine(s)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-secondary-text">
                    {s.completedCount} of {s.attendeeCount} completed
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${pillClass(SESSION_STATUS, s.status)}`}>{sessionStatusLabel(s.status)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sessions.data && (
        <div className="flex items-center justify-between text-sm text-secondary-text">
          <span>
            {sessions.data.total} {sessions.data.total === 1 ? "session" : "sessions"}
          </span>
          <div className="flex gap-2">
            <CTAButton type="neutral" disabled={page <= 1} onClick={() => f.updateFilters({ page: String(page - 1) })}>
              Previous
            </CTAButton>
            <CTAButton type="neutral" disabled={page * sessions.data.pageSize >= sessions.data.total} onClick={() => f.updateFilters({ page: String(page + 1) })}>
              Next
            </CTAButton>
          </div>
        </div>
      )}

      {creating && <SessionDialog onClose={() => setCreating(false)} onSaved={(s) => s?.id && navigate(`/Competence/Training/${s.id}`)} />}
    </div>
  );
};

export default TrainingPage;
