import React from "react";
import { FiTrash2 } from "react-icons/fi";
import { LuPencil } from "react-icons/lu";
import { IoDuplicateOutline } from "react-icons/io5";
import { HiOutlineWrenchScrewdriver } from "react-icons/hi2";
import ActionsModalItem from "./ActionsModalItem";

const ActionsModal = ({ item, onClose }) => {
  return (
    <div className="w-40 h-fit bg-primary-bg rounded-xl border border-border-color shadow-lg flex flex-col justify-center items-center">
      <div className="w-full h-1/4 flex gap-2.5 flex-col p-3 justify-center items-center border-b border-border-color">
        <ActionsModalItem
          label="Edit NC"
          icon={LuPencil}
          color="blue"
          item={item}
          callback={() => {
            console.log(`Editing ${item.id}`);
          }}
        />
        <ActionsModalItem
          label="Duplicate"
          icon={IoDuplicateOutline}
          color="blue"
          item={item}
          callback={() => {
            console.log(`Duplicating ${item.id}`);
          }}
        />
        <ActionsModalItem
          label="Open 8D"
          icon={HiOutlineWrenchScrewdriver}
          color="blue"
          item={item}
          callback={() => {
            console.log(`Opened 8D for ${item.id}`);
          }}
        />
      </div>
      <div className="w-full h-1/4 flex p-3 justify-center items-center">
        <ActionsModalItem
          label="Delete"
          icon={FiTrash2}
          color="red"
          item={item}
          callback={() => {
            console.log(`Deleting ${item.id}`);
          }}
        />
      </div>
    </div>
  );
};

export default ActionsModal;
