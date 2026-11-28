import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import SettingMenuStructure from "../../SettingMenuStructure";
import { useCanSee } from "../../hooks/useQmsApi";
import { ChevronLeftIcon, DatabaseIcon } from "@/components/icons";
import { DATA_PATH, dataTabPath, useDataTabs } from "./dataTabs";

/**
 * The settings pane: a menu of the settings pages with the page beside it. Some entries open a **nested menu** in the same pane, as in a
 * dashboard sidebar: the header changes from "Settings" to the entry's name with a back button, the items slide across and the page
 * beside shows the first of them. Back returns to the settings menu. Data Management is the first: its modules are the nested items.
 *
 * Which level shows comes from the address, so a link straight to a nested page opens with its menu already showing, and the browser's
 * own Back works. Both levels stay mounted while the other shows (the hidden one is inert), which is what lets them slide.
 */
const LEVEL_MOVE = "transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none";

const itemClass = (active) =>
  `flex flex-row cursor-pointer items-center gap-2 rounded-xl px-3 py-1 ${active ? "bg-cta-color" : "hover:bg-border-color/50"}`;

const Item = ({ to, icon: Icon, label, active, replace, style, className = "" }) => (
  <Link to={to} replace={replace} style={style} aria-current={active ? "page" : undefined} className={`mx-2 mt-2 block rounded-xl ${className}`}>
    <div className={itemClass(active)}>
      <Icon className={`${active ? "text-white" : "text-primary-text"} h-4 w-4 shrink-0`} />
      <h2 className={`${active ? "font-semibold text-white" : "text-primary-text"} text-left`}>{label}</h2>
    </div>
  </Link>
);

const Settings = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const canSee = useCanSee();
  const { tabs, current } = useDataTabs();

  const inData = pathname.toLowerCase().startsWith(DATA_PATH.toLowerCase());

  return (
    <div className="flex w-full grow flex-row overflow-y-hidden bg-primary-bg pr-0">
      <div className="flex w-65 min-w-65 flex-col overflow-hidden border-r border-border-color">
        {/* The header: the back button grows in and the title changes as the nested menu opens. */}
        <div className="mt-2 flex h-9 items-center border-b border-border-color pb-2 pl-3 pr-3">
          <button
            type="button"
            onClick={() => navigate("/Settings")}
            aria-label="Back to Settings"
            aria-hidden={!inData}
            inert={!inData}
            className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg text-secondary-text hover:bg-border-color/50 hover:text-primary-text ${LEVEL_MOVE} ${
              inData ? "mr-1 h-7 w-7 opacity-100" : "pointer-events-none mr-0 h-7 w-0 opacity-0"
            }`}
          >
            <ChevronLeftIcon className="h-5 w-5" />
          </button>
          <div className={`grid min-w-0 flex-1 ${inData ? "" : "pl-2"} transition-[padding] duration-300 motion-reduce:transition-none`}>
            <h1 aria-hidden={inData} className={`col-start-1 row-start-1 text-primary-text ${LEVEL_MOVE} ${inData ? "-translate-x-3 opacity-0" : "translate-x-0 opacity-100"}`}>
              Settings
            </h1>
            <h1 aria-hidden={!inData} className={`col-start-1 row-start-1 text-primary-text ${LEVEL_MOVE} ${inData ? "translate-x-0 opacity-100" : "translate-x-3 opacity-0"}`}>
              Data
            </h1>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <nav
            aria-label="Settings"
            aria-hidden={inData}
            inert={inData}
            className={`absolute inset-0 overflow-y-auto pb-2 ${LEVEL_MOVE} ${inData ? "pointer-events-none -translate-x-10 opacity-0" : "translate-x-0 opacity-100"}`}
          >
            {SettingMenuStructure.filter((item) => canSee(item.permission)).map((item) => (
              <Item
                key={item.path}
                to={item.path}
                icon={item.icon ?? DatabaseIcon}
                label={item.name}
                active={pathname.toLowerCase().startsWith(`/settings/${item.path.toLowerCase()}`)}
              />
            ))}
          </nav>
          <nav
            aria-label="Data"
            aria-hidden={!inData}
            inert={!inData}
            className={`absolute inset-0 overflow-y-auto pb-2 ${LEVEL_MOVE} ${inData ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-10 opacity-0"}`}
          >
            {tabs.map((t, i) => (
              <Item
                key={t.value}
                to={dataTabPath(t.value)}
                replace
                icon={t.icon ?? DatabaseIcon}
                label={t.label}
                active={inData && current?.value === t.value}
                // Each item arrives a moment after the one above it as the menu opens.
                style={{ transitionDelay: inData ? `${Math.min(i, 12) * 22}ms` : "0ms" }}
                className={`${LEVEL_MOVE} ${inData ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"}`}
              />
            ))}
          </nav>
        </div>
      </div>
      <div className="flex grow flex-col overflow-y-scroll p-5">
        <Outlet />
      </div>
    </div>
  );
};

export default Settings;
