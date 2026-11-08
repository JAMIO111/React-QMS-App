import { useNavigate } from "react-router-dom";
import { FolderOpenIcon, RotateCcwIcon, Trash2Icon } from "@/components/icons";
import { useToast } from "../../contexts/ToastProvider";
import { usePermissions } from "../../hooks/useQmsApi";
import { useNcrMutation } from "../../hooks/useNcr";
import { describeApiError } from "../../lib/api-client";
import { ncrPath } from "../../lib/ncr";

/** Row (and card) actions for an NCR as DropdownMenu items: open, delete (soft, with a reason, asked by the page) or restore. */
const useNcrRowActions = ({ onDelete }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const mutation = useNcrMutation();
  const { showToast } = useToast();
  const canDelete = can("ncr.delete");

  const restore = (item) =>
    mutation.mutate(
      { path: `/ncrs/${item.id}/restore` },
      {
        onSuccess: () => showToast({ type: "success", title: "Restored", message: `${item.reference} is back in the register.` }),
        onError: (error) => showToast({ type: "error", title: "Not restored", message: describeApiError(error) }),
      }
    );

  return (item) => [
    { label: "Open", icon: FolderOpenIcon, onSelect: () => navigate(ncrPath(item.id)) },
    canDelete && !item.deletedAt && { label: "Delete", icon: Trash2Icon, tone: "danger", onSelect: () => onDelete?.(item) },
    canDelete && item.deletedAt && { label: "Restore", icon: RotateCcwIcon, onSelect: () => restore(item) },
  ];
};

export default useNcrRowActions;
