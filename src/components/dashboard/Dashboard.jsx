import { useUser } from "@/contexts/UserProvider";
import { getGreeting } from "@/lib/HelperFunctions";
import GoLiveCard from "./GoLiveCard";
import HomeAttention from "./HomeAttention";
import OnboardingCard from "./OnboardingCard";
import StartJobCard from "../jobs/StartJobCard";
import ManagementReviewCard from "../management-review/ManagementReviewCard";

const today = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/**
 * The home page: set-up cards while the organisation is being set up, the operator's way into a job, then what needs attention across every
 * area the person may read, their own to-dos, and a card per area (`HomeAttention`).
 */
const Dashboard = () => {
  const { profile } = useUser();

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-primary-bg p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-primary-text">
          {getGreeting()}
          {profile?.first_name ? `, ${profile.first_name}` : ""}
        </h1>
        <p className="text-sm text-secondary-text">{today()} · what needs attention, as of now</p>
      </div>
      <OnboardingCard />
      <GoLiveCard />
      <StartJobCard />
      <HomeAttention />
      <ManagementReviewCard />
    </div>
  );
};

export default Dashboard;
