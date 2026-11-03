import ClientManagementOverviewCard from "@components/ClientManagementOverviewCard";
import { useOwners } from "@/hooks/useOwners";
import { useProperties } from "@/hooks/useProperties";
import LeadsList from "../LeadsList";
import Spinner from "../LoadingSpinner";

const ClientManagementDashboard = () => {
  const { data: owners, isLoading, error } = useOwners();
  const {
    data: properties,
    isLoading: isLoadingProperties,
    error: errorProperties,
  } = useProperties();

  if (isLoading || isLoadingProperties) return <Spinner />;
  if (error || errorProperties) return <div>Error loading data</div>;

  return (
    <div className="h-full items-stretch flex flex-1 gap-4 flex-row bg-primary-bg p-4 min-w-0 overflow-hidden">
      <div className="flex flex-col gap-4 flex-1">
        <ClientManagementOverviewCard owners={owners} properties={properties} />
        <div className="shadow-m flex-1 rounded-3xl bg-secondary-bg"></div>
      </div>
      <div className="flex-1">
        <LeadsList />
      </div>
    </div>
  );
};

export default ClientManagementDashboard;
