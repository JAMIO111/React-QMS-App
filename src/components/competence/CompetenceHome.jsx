import { GraduationCapIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCompetencePositions, useCompetenceSkills } from "../../hooks/useCompetence";
import { groupByCategory, refreshLabel, requirementSummary } from "../../lib/competence";
import { ErrorNotice } from "../master-data/shared";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import MenuCard from "../ui/MenuCard";

/**
 * Competence (CO1): the organisation's skills and positions for reading. Managers set them up in Settings → Data Management → Competence. The matrix, person pages and assessments are CO2.
 */
const CompetenceHome = () => {
  const { can } = usePermissions();
  const skills = useCompetenceSkills();
  const positions = useCompetencePositions();
  if (skills.isLoading || positions.isLoading) return <LoadingScreen />;
  const error = skills.error || positions.error;
  if (error) return <ErrorNotice error={error} />;
  const groups = groupByCategory(skills.data.data);

  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <GraduationCapIcon className="h-7 w-7 text-primary-text" aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-semibold text-primary-text">Competence</h1>
            <p className="text-sm text-secondary-text">The skills people can be assessed on, and what each position needs.</p>
          </div>
        </div>
        {can("competence.manage") && (
          <CTAButton type="secondary" to="/Settings/Data-Management?tab=competence">
            Set up skills and positions
          </CTAButton>
        )}
      </header>

      <Callout tone="info" title="Where people stand">
        The skills matrix shows everyone against what their positions need, and each person's page records assessments. Training sessions are the next step.
        <span className="mt-2 flex flex-wrap gap-2">
          <CTAButton type="secondary" to="/Competence/Matrix">
            Open the skills matrix
          </CTAButton>
          <CTAButton type="neutral" to="/Competence/Mine">
            My competence
          </CTAButton>
        </span>
      </Callout>

      <MenuCard title="Skills" subtitle={`${skills.data.data.length} active`}>
        {skills.data.data.length === 0 ? (
          <p className="text-sm text-secondary-text">No skills have been set up yet.</p>
        ) : (
          groups.map((g) => (
            <section key={g.label} aria-label={g.label} className="mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-secondary-text">{g.label}</h2>
              <ul className="flex flex-col divide-y divide-border-color">
                {g.items.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-baseline gap-3 py-2">
                    <span className="flex-1 text-sm font-medium text-primary-text">
                      {s.name} <span className="font-normal text-secondary-text">· {s.code}</span>
                    </span>
                    <span className="text-xs text-secondary-text">{refreshLabel(s.refreshMonths)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </MenuCard>

      <MenuCard title="Positions" subtitle={`${positions.data.data.length} active`}>
        {positions.data.data.length === 0 ? (
          <p className="text-sm text-secondary-text">No positions have been set up yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-color">
            {positions.data.data.map((p) => (
              <li key={p.id} className="flex flex-col gap-0.5 py-2">
                <span className="text-sm font-medium text-primary-text">
                  {p.name} <span className="font-normal text-secondary-text">· {p.code}</span>
                </span>
                <span className="text-xs text-secondary-text">{requirementSummary(p)}</span>
              </li>
            ))}
          </ul>
        )}
      </MenuCard>
    </div>
  );
};

export default CompetenceHome;
