import { useState } from "react";
import PropertyList from "./PropertyList";
import PropertyDetails from "./PropertyDetails";
import { useProperties } from "@/hooks/useProperties";
import { useGlobalSearch } from "@/contexts/SearchProvider";

const Properties = () => {
  const [selectedProperty, setSelectedProperty] = useState(null);
  const { data: properties, isLoading } = useProperties();
  const { debouncedSearchTerm } = useGlobalSearch();
  console.log("Properties:", properties);

  if (isLoading) return <p>Loading...</p>;

  const filteredProperties = properties?.filter((property) => {
    const name = property.name?.toLowerCase() || "";
    const line_1 = property.line_1?.toLowerCase() || "";
    const line_2 = property.line_2?.toLowerCase() || "";
    const town = property.town?.toLowerCase() || "";
    const county = property.county?.toLowerCase() || "";
    const postcode = property.postcode?.toLowerCase() || "";

    return (
      name.includes(debouncedSearchTerm.toLowerCase()) ||
      line_1.includes(debouncedSearchTerm.toLowerCase()) ||
      line_2.includes(debouncedSearchTerm.toLowerCase()) ||
      town.includes(debouncedSearchTerm.toLowerCase()) ||
      county.includes(debouncedSearchTerm.toLowerCase()) ||
      postcode.includes(debouncedSearchTerm.toLowerCase())
    );
  });
  return (
    <div className="flex flex-row gap-4 p-4 bg-primary-bg h-full w-full">
      <PropertyList
        onSelectProperty={setSelectedProperty}
        selectedProperty={selectedProperty}
        properties={filteredProperties}
      />
      <PropertyDetails
        selectedProperty={selectedProperty}
        property={selectedProperty}
      />
    </div>
  );
};

export default Properties;
