import { LayoutGridIcon, ListIcon } from "@/components/icons";
import SlidingToggle from "./ui/SlidingToggle";

const VIEWS = [
  { value: "list", icon: ListIcon, title: "List view" },
  { value: "grid", icon: LayoutGridIcon, title: "Card view" },
];

/** The table / card switch of a register: a SlidingToggle with two icons. `viewGrid` is true for cards; `setViewGrid(true|false)` picks one. */
const ViewToggle = ({ viewGrid, setViewGrid }) => (
  <SlidingToggle ariaLabel="Switch view" options={VIEWS} value={viewGrid ? "grid" : "list"} onChange={(v) => setViewGrid(v === "grid")} />
);

export default ViewToggle;
