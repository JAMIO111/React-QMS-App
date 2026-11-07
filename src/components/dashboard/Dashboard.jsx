import { useUser } from "@/contexts/UserProvider";
import { getGreeting } from "@/lib/HelperFunctions";
import GoLiveCard from "./GoLiveCard";
import OnboardingCard from "./OnboardingCard";

const Dashboard = () => {
  const { profile } = useUser();

  return (
    <div className="flex flex-col flex-1 gap-5 p-5 overflow-auto bg-primary-bg">
      <h1 className="text-xl font-semibold text-primary-text pl-1">
        {getGreeting()}
        {profile?.first_name ? `, ${profile.first_name}` : ""}
      </h1>
      <OnboardingCard />
      <GoLiveCard />
    </div>
  );
};

export default Dashboard;
