import { BellIcon, MailIcon, MenuIcon } from "@/components/icons";
import HeaderIcon from "./HeaderIcon";
import SearchBar from "./ui/SearchBar";
import { useUser } from "../contexts/UserProvider";
import { useNotification } from "../contexts/NotificationProvider";
import { useBadges } from "../hooks/useBadges";
import OrganisationSwitcher from "./OrganisationSwitcher";
import ProfileMenu from "./ProfileMenu";

const Header = ({ onOpenMenu }) => {
  const { profile } = useUser();
  const userName =
    [profile?.first_name, profile?.surname].filter(Boolean).join(" ") ||
    profile?.email ||
    "User";
  const jobTitle = profile?.job_title ?? "";
  const { openPane } = useNotification();
  const { data: counts } = useBadges();

  const newNotifications = counts?.notifications ?? 0;

  return (
    <header className="flex items-center border-b-1 border-border-color bg-secondary-bg px-2 md:justify-between md:px-4">
      {/* The side menu is hidden below the md width: this opens it as a drawer. */}
      <button
        type="button"
        aria-label="Open the menu"
        onClick={onOpenMenu}
        className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-icon-color hover:text-primary-text md:hidden">
        <MenuIcon className="h-6 w-6" />
      </button>
      <SearchBar />
      <div className="flex shrink-0 items-center gap-1 py-2 md:justify-between md:gap-3">
        <div className="hidden md:block">
          <OrganisationSwitcher />
        </div>
        <HeaderIcon icon={MailIcon} top={7} right={3} />
        <button onClick={() => openPane()}>
          <HeaderIcon
            showBadge={newNotifications > 0}
            icon={BellIcon}
            top={8}
            right={8}
          />
        </button>
        <div className="ml-3 hidden flex-col sm:flex">
          <span className="text-primary-text text-sm text-right font-semibold">
            {userName}
          </span>
          <span className="text-right text-sm text-secondary-text">
            {jobTitle}
          </span>
        </div>
        <ProfileMenu />
      </div>
    </header>
  );
};

export default Header;
