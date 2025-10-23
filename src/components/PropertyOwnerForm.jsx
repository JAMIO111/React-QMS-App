import { useState, useEffect, useMemo } from "react";
import CTAButton from "./CTAButton";
import RHFComboBox from "./ui/RHFComboBox";
import { IoTrash } from "react-icons/io5";
import { useOwners } from "@/hooks/useOwners";
import { FaUser } from "react-icons/fa6";

const PropertyOwnerForm = ({ defaultOwners = [], onSave, onCancel }) => {
  const { data: owners, isLoading: ownersLoading } = useOwners();
  // start with defaults right away so UI renders them immediately
  const [currentOwners, setCurrentOwners] = useState(() => [
    ...(defaultOwners || []),
  ]);
  const [selectedOwnerId, setSelectedOwnerId] = useState(null);
  console.log("Current Owners:", currentOwners);
  console.log("Selected Owner ID:", selectedOwnerId);

  // If defaultOwners prop changes, update immediately
  useEffect(() => {
    setCurrentOwners([...(defaultOwners || [])]);
  }, [defaultOwners]);

  // When the full owners list becomes available, reconcile the currentOwners
  // to use canonical objects from `owners` (match by id), preserving any local-only data.
  useEffect(() => {
    if (!owners) return;
    setCurrentOwners((prev) =>
      prev.map((d) => {
        const match = owners.find((o) => String(o.id) === String(d.id));
        return match || d; // prefer canonical owner from owners[], fallback to existing
      })
    );
  }, [owners]);

  // Build options excluding currentOwners (by id). Normalize ids to strings.
  const filteredOwners = useMemo(() => {
    if (!owners) return [];
    const excluded = new Set(currentOwners.map((o) => String(o.id)));
    return owners
      .filter((o) => !excluded.has(String(o.id)))
      .map((o) => ({ id: o.id, name: `${o.first_name} ${o.surname}` }));
  }, [owners, currentOwners]);

  const handleAddOwner = () => {
    if (!selectedOwnerId || !owners) return;
    const ownerToAdd = owners.find(
      (o) => String(o.id) === String(selectedOwnerId)
    );
    if (!ownerToAdd) return;
    // avoid duplicates (defensive)
    if (currentOwners.some((o) => String(o.id) === String(ownerToAdd.id))) {
      setSelectedOwnerId(null);
      return;
    }
    setCurrentOwners((prev) => [...prev, ownerToAdd]);
    setSelectedOwnerId(null);
  };

  const handleRemoveOwner = (id) => {
    setCurrentOwners((prev) => prev.filter((o) => String(o.id) !== String(id)));
  };

  const handleSubmit = () => {
    // map currentOwners to just owner_id for the mutation
    const ownersPayload = currentOwners.map((o) => ({ owner_id: o.id, ...o }));
    onSave(ownersPayload);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <RHFComboBox
        label="Select Owner"
        icon={FaUser}
        options={filteredOwners}
        value={selectedOwnerId}
        onChange={setSelectedOwnerId}
        placeholder={
          ownersLoading ? "Loading owners…" : "Select an owner to add..."
        }
        // optionally disable until owners load to avoid confusing empty list
        // you can remove this prop if you want it selectable before load
        // pass dependentKey/dependentValue instead if your combobox supports it
      />

      <div className="flex gap-2 items-center">
        <CTAButton
          type="main"
          text="Add"
          width="w-80"
          callbackFn={handleAddOwner}
          disabled={!selectedOwnerId || ownersLoading}
        />
      </div>

      <ul className="flex flex-col p-1 gap-2 max-h-60 overflow-y-auto">
        {currentOwners.length === 0 && (
          <li className="text-sm text-primary-text">No owners added yet.</li>
        )}
        {currentOwners.map((owner) => (
          <li
            key={owner.id}
            className="flex justify-between items-center p-2 bg-tertiary-bg rounded-lg gap-3 shadow-s">
            {owner.avatar ? (
              <img
                src={owner.avatar}
                alt={`${owner.first_name} ${owner.surname}`}
                className="w-12 h-12 rounded-lg object-cover"
              />
            ) : (
              <div className="flex items-center justify-center shadow-s w-12 h-12 rounded-lg bg-primary-bg">
                <p className="text-lg font-semibold text-primary-text">
                  {(owner.first_name?.[0] || "").toUpperCase()}
                  {(owner.surname?.[0] || "").toUpperCase()}
                </p>
              </div>
            )}

            <span className="font-medium flex-1 text-left text-primary-text">
              {owner.first_name} {owner.surname}
            </span>

            <button
              onClick={() => handleRemoveOwner(owner.id)}
              className="p-1.5 cursor-pointer hover:shadow-s rounded-lg hover:text-error-color mr-1.5">
              <IoTrash className="h-6 w-6" />
            </button>
          </li>
        ))}
      </ul>

      <div className="flex gap-2 pt-2">
        <CTAButton
          width="w-full"
          type="cancel"
          text="Cancel"
          callbackFn={onCancel}
        />
        <CTAButton
          width="w-full"
          type="success"
          text="Save"
          callbackFn={handleSubmit}
        />
      </div>
    </div>
  );
};

export default PropertyOwnerForm;
