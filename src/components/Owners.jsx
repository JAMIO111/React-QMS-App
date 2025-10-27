import { useState } from "react";
import OwnerList from "./OwnerList";
import OwnerDetails from "./OwnerDetails";
import { useOwners } from "@/hooks/useOwners";
import { useGlobalSearch } from "@/contexts/SearchProvider";
import { useLocation } from "react-router-dom";
import Spinner from "@components/LoadingSpinner";

const Owners = () => {
  const location = useLocation();
  const [selectedOwner, setSelectedOwner] = useState(
    location?.state?.owner ?? null
  );
  const { data: owners, isLoading } = useOwners();
  const { debouncedSearchTerm } = useGlobalSearch();

  if (isLoading) return <Spinner />;

  const filteredOwners = owners?.filter((owner) => {
    const fullName = `${owner.first_name} ${owner.surname}`.toLowerCase();
    const email = owner.primary_email?.toLowerCase() || "";
    const phone = owner.primary_phone?.toLowerCase() || "";

    return (
      fullName.includes(debouncedSearchTerm.toLowerCase()) ||
      email.includes(debouncedSearchTerm.toLowerCase()) ||
      phone.includes(debouncedSearchTerm.toLowerCase())
    );
  });
  return (
    <div className="flex flex-row gap-4 p-4 bg-primary-bg h-full w-full">
      <OwnerList
        onSelectOwner={setSelectedOwner}
        selectedOwner={selectedOwner}
        owners={filteredOwners}
      />
      <OwnerDetails owner={selectedOwner} />
    </div>
  );
};

export default Owners;
