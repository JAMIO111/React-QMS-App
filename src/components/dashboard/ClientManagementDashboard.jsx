import ClientManagementOverviewCard from "@components/ClientManagementOverviewCard";
import { useOwners } from "@/hooks/useOwners";
import { useProperties } from "@/hooks/useProperties";

const ClientManagementDashboard = () => {
  const { data: owners, isLoading, error } = useOwners();
  const {
    data: properties,
    isLoading: isLoadingProperties,
    error: errorProperties,
  } = useProperties();

  if (isLoading || isLoadingProperties) return <div>Loading...</div>;
  if (error || errorProperties) return <div>Error loading data</div>;

  return (
    <div className="h-full flex flex-1 flex-row bg-primary-bg p-3 min-w-0 overflow-hidden">
      <div className="flex flex-col flex-1">
        <ClientManagementOverviewCard owners={owners} properties={properties} />
      </div>
      <div className="flex-1"></div>
    </div>
  );
};

export default ClientManagementDashboard;
