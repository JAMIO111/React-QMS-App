import { BellIcon, MailIcon } from "@/components/icons";
import HeaderIcon from "./HeaderIcon";
import SearchBar from "./ui/SearchBar";
import { useUser } from "../contexts/UserProvider";
import { useNotification } from "../contexts/NotificationProvider";
import { useNotifications } from "../hooks/useNotifications";
import OrganisationSwitcher from "./OrganisationSwitcher";
import ProfileMenu from "./ProfileMenu";

const Header = () => {
  const { profile } = useUser();
  const userName =
    [profile?.first_name, profile?.surname].filter(Boolean).join(" ") ||
    profile?.email ||
    "User";
  const jobTitle = profile?.job_title ?? "";
  const { openPane } = useNotification();
  const { data: notificationData } = useNotifications();

  const newNotifications = notificationData?.unread ?? 0;

  return (
    <header className="flex justify-between items-center border-b-1 border-border-color bg-secondary-bg px-4">
      <SearchBar />
      <div className="flex justify-between items-center py-2 gap-3">
        <OrganisationSwitcher />
        <HeaderIcon icon={MailIcon} top={7} right={3} />
        <button onClick={() => openPane()}>
          <HeaderIcon
            showBadge={newNotifications > 0}
            icon={BellIcon}
            top={8}
            right={8}
          />
        </button>
        <div className="flex flex-col ml-3">
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
