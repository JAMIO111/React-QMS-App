import { createPortal } from "react-dom";
import { Trash2Icon } from "@/components/icons";
import ActionsModalItem from "./ActionsModalItem";
import { useQueryClient } from "@tanstack/react-query";
import { deleteRow } from "../api/supabaseApi";
import { useToast } from "../contexts/ToastProvider";
import { useConfirm } from "../contexts/ConfirmationModalProvider";

const ActionsModal = ({ item, position }) => {
  const queryClient = useQueryClient();

  const { showToast } = useToast();
  const confirm = useConfirm();

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: "Are you sure you want to delete this record?",
      message: "This action can't be undone.",
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "warning",
    });
    if (ok) {
      try {
        await deleteRow("NCM", id);
        await queryClient.invalidateQueries({ queryKey: [item.type] });
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

  return createPortal(
    <div
      className="w-44 h-fit bg-secondary-bg rounded-xl border border-border-color shadow-lg flex flex-col justify-center items-center"
      style={{
        position: "absolute",
        top: position.top,
        left: position.left,
        zIndex: 1000,
      }}>
      <div className="w-full h-1/4 flex p-2 justify-center items-center">
        <ActionsModalItem
          label="Delete"
          icon={Trash2Icon}
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
