import { useState, useEffect, useMemo } from "react";
import CTAButton from "./CTAButton";
import RHFComboBox from "./ui/RHFComboBox";
import { IoTrashOutline } from "react-icons/io5";
import { useOwners } from "@/hooks/useOwners";
import { FaUser } from "react-icons/fa6";

const PropertyOwnerForm = ({ defaultOwners = [], onSave, onCancel }) => {
  const { data: owners, isLoading: ownersLoading } = useOwners();

  const [currentOwners, setCurrentOwners] = useState(() => [
    ...(defaultOwners || []),
  ]);

  useEffect(() => {
    setCurrentOwners([...(defaultOwners || [])]);
  }, [defaultOwners]);

  useEffect(() => {
    if (!owners) return;
    setCurrentOwners((prev) =>
      prev.map((d) => {
        const match = owners.find((o) => String(o.id) === String(d.id));
        return match || d;
      })
    );
  }, [owners]);

  const filteredOwners = useMemo(() => {
    if (!owners) return [];
    const excluded = new Set(currentOwners.map((o) => String(o.id)));
    return owners
      .filter((o) => !excluded.has(String(o.id)))
      .map((o) => ({ id: o.id, name: `${o.first_name} ${o.surname}` }));
  }, [owners, currentOwners]);

  const handleAddOwner = (id) => {
    if (!id || !owners) return;
    const ownerToAdd = owners.find((o) => String(o.id) === String(id));
    if (!ownerToAdd) return;
    if (currentOwners.some((o) => String(o.id) === String(ownerToAdd.id)))
      return;
    setCurrentOwners((prev) => [...prev, ownerToAdd]);
  };

  const handleRemoveOwner = (id) => {
    setCurrentOwners((prev) => prev.filter((o) => String(o.id) !== String(id)));
  };

  const handleSubmit = () => {
    onSave(currentOwners);
  };

  return (
    <div className="flex flex-col min-h-[50vh] min-w-[30vw] gap-4 p-4">
      <RHFComboBox
        label="Select Owner"
        icon={FaUser}
        options={filteredOwners}
        value={null}
        onChange={(id) => handleAddOwner(id)}
        placeholder={
          ownersLoading ? "Loading owners…" : "Select an owner to add..."
        }
      />

      <ul className="flex flex-1 flex-col p-1 gap-2  max-h-60 overflow-y-auto">
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
              className="p-2 cursor-pointer hover:shadow-s rounded-lg text-icon-color hover:text-error-color mr-1.5">
              <IoTrashOutline className="h-5 w-5" />
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
