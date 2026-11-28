import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import SettingMenuStructure from "../../SettingMenuStructure";
import { useCanSee } from "../../hooks/useQmsApi";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
} from "@/components/icons";
import { DATA_PATH, dataTabPath, useDataTabs } from "./dataTabs";

/**
 * The settings pane: a menu of the settings pages with the page beside it. Some entries open a **nested menu** in the same pane, as in a
 * dashboard sidebar: the header changes from "Settings" to the entry's name with a back button, the items slide across and the page
 * beside shows the first of them. Back returns to the settings menu. Data Management is the first: its modules are the nested items.
 *
 * Which level shows comes from the address, so a link straight to a nested page opens with its menu already showing, and the browser's
 * own Back works. Both levels stay mounted while the other shows (the hidden one is inert), which is what lets them slide.
 *
 * On a phone (below `md`) there is no room for a menu beside the page, so it is **one pane at a time**: the menu (or the Data menu) fills the screen, a
 * choice shows the page with a "‹ Settings" bar above it, and that bar goes back to the menu. Which one shows again comes from the address:
 * `/Settings` and `/Settings/Data-Management` with no `?tab=` are the menus.
 */
const LEVEL_MOVE =
  "transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none";

const itemClass = (active) =>
  `group flex flex-row cursor-pointer items-center gap-2 rounded-lg px-3 py-1 pointer-coarse:py-2.5 ${active ? "bg-cta-color" : "hover:bg-border-color/50"}`;

/** `nested` marks an entry that opens a menu of its own: a small arrow on the right says so, and nudges along on hover. */
const Item = ({
  to,
  icon: Icon,
  label,
  active,
  replace,
  nested,
  style,
  className = "",
}) => (
  <Link
    to={to}
    replace={replace}
    style={style}
    aria-current={active ? "page" : undefined}
    className={`block ${className}`}>
    <div className={itemClass(active)}>
      <Icon
        className={`${active ? "text-white" : "text-primary-text"} h-4 w-4 shrink-0`}
      />
      <h2
        className={`${active ? "font-semibold text-white" : "text-primary-text"} text-left`}>
        {label}
      </h2>
      {nested && (
        <ChevronRightIcon
          aria-hidden="true"
          className={`ml-auto h-4 w-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none ${active ? "text-white" : "text-secondary-text"}`}
        />
      )}
    </div>
  </Link>
);

const Settings = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const canSee = useCanSee();
  const { tabs, current } = useDataTabs();
  const [params] = useSearchParams();

  const inData = pathname.toLowerCase().startsWith(DATA_PATH.toLowerCase());
  // On a phone: is a menu the whole screen (true), or the page (false)?
  const atSettingsRoot = pathname.replace(/\/+$/, "").toLowerCase() === "/settings";
  const showMenu = atSettingsRoot || (inData && !params.get("tab"));

  return (
    <div className="flex w-full grow flex-row overflow-y-hidden bg-primary-bg pr-0">
      <div
        className={`${showMenu ? "flex w-full" : "hidden"} flex-col overflow-hidden border-r border-border-color md:flex md:w-65 md:min-w-65`}>
        {/* The header: the whole row goes back once the nested menu is open (the button lies under it, and the words let clicks through); the arrow grows in and the title changes as it opens. */}
        <div className="relative mt-2 flex h-9 items-center border-b border-border-color pb-2 pl-3 pr-3">
          <button
            type="button"
            onClick={() => navigate("/Settings")}
            aria-label="Back to Settings"
            aria-hidden={!inData}
            inert={!inData}
            tabIndex={inData ? 0 : -1}
            className={`absolute inset-x-1 inset-y-0 mb-2 cursor-pointer rounded-lg hover:bg-border-color/50 ${inData ? "" : "pointer-events-none"}`}
          />
          <span
            aria-hidden="true"
            className={`pointer-events-none relative flex shrink-0 items-center justify-center overflow-hidden text-secondary-text ${LEVEL_MOVE} ${inData ? "mr-1 h-7 w-7 opacity-100" : "mr-0 h-7 w-0 opacity-0"}`}>
            <ChevronLeftIcon className="h-5 w-5" />
          </span>
          <div
            className={`pointer-events-none relative grid min-w-0 flex-1 ${inData ? "" : "pl-2"} transition-[padding] duration-300 motion-reduce:transition-none`}>
            <h1
              aria-hidden={inData}
              className={`col-start-1 row-start-1 text-primary-text ${LEVEL_MOVE} ${inData ? "-translate-x-3 opacity-0" : "translate-x-0 opacity-100"}`}>
              Settings
            </h1>
            <h1
              aria-hidden={!inData}
              className={`col-start-1 row-start-1 text-primary-text ${LEVEL_MOVE} ${inData ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0"}`}>
              Data
            </h1>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <nav
            aria-label="Settings"
            aria-hidden={inData}
            inert={inData}
            className={`absolute inset-0 flex flex-col gap-1 overflow-y-auto p-2 ${LEVEL_MOVE} ${inData ? "pointer-events-none -translate-x-10 opacity-0" : "translate-x-0 opacity-100"}`}>
            {SettingMenuStructure.filter((item) => canSee(item.permission)).map(
              (item) => (
                <Item
                  key={item.path}
                  to={item.path}
                  icon={item.icon ?? DatabaseIcon}
                  label={item.name}
                  nested={item.path === "Data-Management"}
                  active={pathname
                    .toLowerCase()
                    .startsWith(`/settings/${item.path.toLowerCase()}`)}
                />
              ),
            )}
          </nav>
          <nav
            aria-label="Data"
            aria-hidden={!inData}
            inert={!inData}
            className={`absolute inset-0 flex flex-col gap-1 overflow-y-auto p-2 ${LEVEL_MOVE} ${inData ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-10 opacity-0"}`}>
            {tabs.map((t, i) => (
              <Item
                key={t.value}
                to={dataTabPath(t.value)}
                replace
                icon={t.icon ?? DatabaseIcon}
                label={t.label}
                active={inData && current?.value === t.value}
                // Each item arrives a moment after the one above it as the menu opens.
                style={{
                  transitionDelay: inData ? `${Math.min(i, 12) * 22}ms` : "0ms",
                }}
                className={`${LEVEL_MOVE} ${inData ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"}`}
              />
            ))}
          </nav>
        </div>
      </div>
      <div className={`${showMenu ? "hidden md:flex" : "flex"} min-w-0 grow flex-col overflow-y-scroll p-3 md:p-5`}>
        {/* Phone only: back to the menu this page was chosen from. */}
        <button
          type="button"
          onClick={() => navigate(inData ? DATA_PATH : "/Settings")}
          className="-mt-1 mb-3 flex h-10 w-fit shrink-0 cursor-pointer items-center gap-1 rounded-lg pr-3 text-sm font-semibold text-primary-text hover:bg-border-color/50 md:hidden">
          <ChevronLeftIcon className="h-5 w-5 text-secondary-text" />
          {inData ? "Data" : "Settings"}
        </button>
        <Outlet />
      </div>
    </div>
  );
};

export default Settings;
