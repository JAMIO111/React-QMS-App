import { GraduationCapIcon } from "@/components/icons";
import { useMyCompetence } from "../../hooks/useCompetence";
import { ErrorNotice } from "../master-data/shared";
import Callout from "../ui/Callout";
import LoadingScreen from "../ui/LoadingScreen";
import ProfileView from "./ProfileView";

/** My competence (`/Competence/Mine`): the caller's own record, read only. Needs their sign-in linked to an employee (Master Data → Employees). */
const MyCompetencePage = () => {
  const mine = useMyCompetence();
  if (mine.isLoading) return <LoadingScreen />;
  if (mine.error) return <ErrorNotice error={mine.error} />;
  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex items-center gap-3">
        <GraduationCapIcon className="h-7 w-7 text-primary-text" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">My competence</h1>
          <p className="text-sm text-secondary-text">What your positions ask of you and where you stand. Someone else records your assessments.</p>
        </div>
      </header>
      {mine.data.linked ? (
        <ProfileView profile={mine.data} />
      ) : (
        <Callout tone="info" title="Your sign-in is not linked to an employee record">
          Ask someone who manages the employees register to link it (Master Data → Employees). Then your positions and assessments will show here.
        </Callout>
      )}
    </div>
  );
};

export default MyCompetencePage;
