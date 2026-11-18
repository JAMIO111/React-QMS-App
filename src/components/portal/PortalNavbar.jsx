import { useState } from "react";
import { NavLink } from "react-router-dom";
import FortressMark from "../../assets/fortress-qms.png";
import { ClipboardCheckIcon, ClipboardListIcon, FileTextIcon, LayoutDashboardIcon, MessageSquarePlusIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, ShieldCheckIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";
import NavItem from "../NavItem";
import { portalMenu } from "../../lib/portal";

const ICONS = {
  dashboard: LayoutDashboardIcon,
  ncr: TriangleAlertIcon,
  scar: ClipboardCheckIcon,
  capa: ClipboardListIcon,
  complaint: MessageSquarePlusIcon,
  document: FileTextIcon,
  certificate: ShieldCheckIcon,
  team: UsersIcon,
};

/**
 * The portal's side menu, the main app's own (same items, same collapse, same badges) with only what this kind of party has. `badges` counts what
 * is waiting for the person per menu key. Below the `md` width the menu becomes a row of links under the header, as the main app hides its side menu there.
 */
export default function PortalNavbar({ access, badges = {}, mobile = false }) {
  const [expanded, setExpanded] = useState(false);
  const items = portalMenu(access);

  if (mobile) {
    return (
      <nav aria-label="Portal menu on a small screen" className="no-scrollbar flex gap-1 overflow-x-auto border-b border-border-color bg-secondary-bg px-2 py-1 md:hidden">
        {items.map((item) => (
          <NavLink
            key={item.key}
            to={item.path}
            end={!!item.end}
            className={({ isActive }) => `flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${isActive ? "bg-cta-color/50 text-white" : "text-primary-text hover:bg-cta-color/10"}`}>
            {item.name}
            {(badges[item.badge] ?? 0) > 0 && <span className="rounded-full bg-error-color px-1.5 text-xs font-medium text-white">{badges[item.badge]}</span>}
          </NavLink>
        ))}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Portal menu"
      className={`hidden h-full shrink-0 flex-col overflow-hidden whitespace-nowrap border-r border-border-color bg-secondary-bg transition-[width] duration-300 ease-in-out motion-reduce:transition-none md:flex ${expanded ? "w-68" : "w-14"}`}>
      <div className={`flex items-center border-b border-border-color py-3 ${expanded ? "mx-3 flex-row" : "flex-col gap-3"}`}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-border-color bg-white">
          <img className="h-full w-full object-contain" src={FortressMark} alt="Fortress QMS" />
        </div>
        {expanded && (
          <div className="ml-3 flex min-w-0 flex-1 flex-col items-start">
            <h1 className="w-full truncate text-xs font-semibold text-primary-text" title={access?.organisationName}>{access?.organisationName ?? "Fortress QMS"}</h1>
            <p className="truncate text-xs text-secondary-text">Portal for {access?.partyName}</p>
          </div>
        )}
        <button title={expanded ? "Hide menu" : "Expand menu"} aria-label={expanded ? "Hide menu" : "Expand menu"} onClick={() => setExpanded((e) => !e)} className="cursor-pointer">
          {expanded ? <PanelLeftCloseIcon className="h-6 w-6 text-icon-color hover:text-primary-text" /> : <PanelLeftOpenIcon className="h-6 w-6 text-icon-color hover:text-primary-text" />}
        </button>
      </div>
      <ul className="no-scrollbar flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pt-3">
        {items.map((item) => (
          <li key={item.key}>
            <NavItem title={item.name} label={item.name} icon={ICONS[item.icon]} path={item.path} end={!!item.end} isExpanded={expanded} closeMenu={() => setExpanded(false)} hasSubMenu={false} badge={badges[item.badge] ?? 0} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
