import { useState } from "react";
import { createPortal } from "react-dom";
import { FiTrash2 } from "react-icons/fi";
import { LuPencil } from "react-icons/lu";
import { IoDuplicateOutline } from "react-icons/io5";
import { HiOutlineWrenchScrewdriver } from "react-icons/hi2";
import ActionsModalItem from "./ActionsModalItem";
import { useQueryClient } from "@tanstack/react-query";
import { deleteRow } from "../api/supabaseApi";
import { useNavigate } from "react-router-dom";
import { useToast } from "../contexts/ToastProvider";
import { useConfirm } from "../contexts/ConfirmationModalProvider";

const ActionsModal = ({ item, position }) => {
  const queryClient = useQueryClient();

  const { showToast } = useToast();
  const confirm = useConfirm();

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: "Delete Record",
      message:
        "Are you sure you want to delete this record? This action cannot be undone.",
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "warning",
    });
    if (ok) {
      try {
        await deleteRow("NCM", id);
        await queryClient.invalidateQueries(["Internal-NC"]);
        showToast({
          type: "success",
          title: "Deleted",
          message: "The record was successfully deleted.",
        });
      } catch (err) {
        console.error("Failed to delete:", err);
        showToast({
          type: "error",
          title: "Deletion Failed",
          message: "We were unable to delete the record.",
        });
      }
    }
  };

  const navigate = useNavigate();

  const handleEditNC = () => {
    console.log(`Editing ${item.id}`);
    navigate("/Non-Conformance/Internal/NC-Form", {
      state: {
        itemID: item.id, // could be null for a new one
      },
    });
  };

  return createPortal(
    <div
      className="w-40 h-fit bg-primary-bg rounded-xl border border-border-color shadow-lg flex flex-col justify-center items-center"
      style={{
        position: "absolute",
        top: position.top,
        left: position.left,
        zIndex: 1000,
      }}>
      <div className="w-full h-1/4 flex gap-2.5 flex-col p-3 justify-center items-center border-b border-border-color">
        <ActionsModalItem
          path="/Non-Conformance/Internal/NC-Form"
          label="Edit NC"
          icon={LuPencil}
          color="blue"
          item={item}
          callback={handleEditNC}
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
          callback={handleDelete}
        />
      </div>
    </div>,
    document.getElementById("modal-root")
  );
};

export default ActionsModal;
