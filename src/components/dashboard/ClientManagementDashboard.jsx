import ClientManagementOverviewCard from "@components/ClientManagementOverviewCard";

const ClientManagementDashboard = () => {
  return (
    <div className="h-full flex flex-1 flex-row bg-primary-bg p-3 min-w-0 overflow-hidden">
      <div className="flex flex-col flex-1">
        <ClientManagementOverviewCard />
      </div>
      <div className="flex-1"></div>
    </div>
  );
};

export default ClientManagementDashboard;
