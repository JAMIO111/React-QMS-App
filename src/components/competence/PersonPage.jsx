import { useParams } from "react-router-dom";
import { GraduationCapIcon } from "@/components/icons";
import CTAButton from "@/components/CTAButton";
import { usePermissions } from "../../hooks/useQmsApi";
import { useCompetencePerson } from "../../hooks/useCompetence";
import { useBreadcrumbNames } from "../../lib/breadcrumbs";
import { ErrorNotice } from "../master-data/shared";
import LoadingScreen from "../ui/LoadingScreen";
import ProfileView from "./ProfileView";

/** One person's competence (`/Competence/People/:employeeId`): for people who may read competence; assessing and giving positions follow their rights. */
const PersonPage = () => {
  const { employeeId } = useParams();
  const { can } = usePermissions();
  const person = useCompetencePerson(employeeId);
  useBreadcrumbNames([{ path: `/Competence/People/${employeeId}`, label: person.data?.employee.name ?? null }, { path: "/Competence/People", label: "Matrix", to: "/Competence/Matrix" }]);
  if (person.isLoading) return <LoadingScreen />;
  if (person.error) return <ErrorNotice error={person.error} />;
  const { employee } = person.data;
  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <GraduationCapIcon className="h-7 w-7 text-primary-text" aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-semibold text-primary-text">{employee.name}</h1>
            <p className="text-sm text-secondary-text">{[employee.jobTitle, employee.employeeNumber].filter(Boolean).join(" · ") || "Competence record"}</p>
          </div>
        </div>
        <CTAButton type="secondary" to="/Competence/Matrix">
          Back to the matrix
        </CTAButton>
      </header>
      <ProfileView profile={person.data} canAssess={can("competence.assess")} canManage={can("competence.manage")} />
    </div>
  );
};

export default PersonPage;
