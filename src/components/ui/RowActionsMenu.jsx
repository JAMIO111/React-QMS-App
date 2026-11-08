import { EllipsisIcon } from "@/components/icons";
import DropdownMenu from "./DropdownMenu";

/**
 * The "…" button at the end of a table row (or a card) and the menu it opens: `items` as for DropdownMenu, `label` names the menu
 * ("Actions for NCM-26-001"). Renders nothing when there is nothing to offer. Clicking it never reaches the row (no row open / select).
 */
const RowActionsMenu = ({ items, label = "Actions", trigger }) => {
  if (!items?.some(Boolean)) return null;
  return (
    <DropdownMenu
      label={label}
      items={items}
      trigger={(props, state) =>
        trigger ? (
          trigger({ ...props, onClick: (e) => { e.stopPropagation(); props.onClick(); } }, state)
        ) : (
          <button
            {...props}
            aria-label="Actions"
            onClick={(e) => {
              e.stopPropagation();
              props.onClick();
            }}
            className="p-1 text-secondary-text hover:text-brand-primary cursor-pointer">
            <EllipsisIcon size={18} />
          </button>
        )
      }
    />
  );
};

export default RowActionsMenu;
