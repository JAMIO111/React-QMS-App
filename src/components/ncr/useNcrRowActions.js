import { useNavigate } from "react-router-dom";
import { FolderOpenIcon, RotateCcwIcon, Trash2Icon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useNcrMutation } from "../../hooks/useNcr";
import { ncrRestore } from "../../lib/ncrGuesses";
import { ncrPath } from "../../lib/ncr";

/** Row (and card) actions for an NCR as DropdownMenu items: open, delete (soft, with a reason, asked by the page) or restore. */
const useNcrRowActions = ({ onDelete }) => {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const mutation = useNcrMutation();
  const canDelete = can("ncr.delete");

  // Back in the register at once; a refusal puts it back and is told in a toast (useNcrMutation).
  const restore = (item) => mutation.mutate({ path: `/ncrs/${item.id}/restore`, guess: ncrRestore(item.id), failed: "Not restored" });

  return (item) => [
    { label: "Open", icon: FolderOpenIcon, onSelect: () => navigate(ncrPath(item.id)) },
    canDelete && !item.deletedAt && { label: "Delete", icon: Trash2Icon, tone: "danger", onSelect: () => onDelete?.(item) },
    canDelete && item.deletedAt && { label: "Restore", icon: RotateCcwIcon, onSelect: () => restore(item) },
  ];
};

export default useNcrRowActions;
