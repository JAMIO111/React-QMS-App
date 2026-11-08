import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { FolderOpenIcon, RotateCcwIcon, Trash2Icon } from "@/components/icons";
import ActionsModalItem from "./ActionsModalItem";
import { useToast } from "../contexts/ToastProvider";
import { usePermissions } from "../hooks/useQmsApi";
import { useNcrMutation } from "../hooks/useNcr";
import { describeApiError } from "../lib/api-client";
import { ncrPath } from "../lib/ncr";

/** Row actions for an NCR: open, delete (soft, with a reason — handled by the page) or restore. */
const ActionsModal = ({ item, position, onClose, onDelete }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const canDelete = can("ncr.delete");

  const restore = () =>
    mutation.mutate(
      { path: `/ncrs/${item.id}/restore` },
      {
        onSuccess: () => {
          showToast({ type: "success", title: "Restored", message: `${item.reference} is back in the register.` });
          onClose?.();
        },
        onError: (error) => showToast({ type: "error", title: "Not restored", message: describeApiError(error) }),
      }
    );

  return createPortal(
    <div
      role="menu"
      aria-label={`Actions for ${item.reference}`}
      className="w-44 h-fit bg-secondary-bg rounded-xl border border-border-color shadow-lg flex flex-col gap-1 p-2"
      style={{ position: "absolute", top: position.top, left: position.left, zIndex: 1000 }}>
      <ActionsModalItem label="Open" icon={FolderOpenIcon} item={item} callback={() => navigate(ncrPath(item.id))} />
      {canDelete && !item.deletedAt && <ActionsModalItem label="Delete" icon={Trash2Icon} color="red" item={item} callback={() => onDelete?.(item)} />}
      {canDelete && item.deletedAt && <ActionsModalItem label="Restore" icon={RotateCcwIcon} item={item} callback={restore} />}
    </div>,
    document.getElementById("modal-root")
  );
};

export default ActionsModal;
