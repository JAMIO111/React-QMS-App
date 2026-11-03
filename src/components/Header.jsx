import { BellIcon, MailIcon } from "@/components/icons";
import HeaderIcon from "./HeaderIcon";
import SearchBar from "./ui/SearchBar";
import { useUser } from "../contexts/UserProvider";
import { useNotification } from "../contexts/NotificationProvider";
import { useNotifications } from "../hooks/useNotifications";
import useSignedAvatarUrl from "../hooks/useSignedAvatarURL";
import OrganisationSwitcher from "./OrganisationSwitcher";

const Header = () => {
  const { profile } = useUser();
  const userName =
    [profile?.first_name, profile?.surname].filter(Boolean).join(" ") ||
    profile?.email ||
    "User";
  const jobTitle = profile?.job_title ?? "";
  const { signedUrl: avatarUrl } = useSignedAvatarUrl(profile?.avatar_path);
  const { openPane } = useNotification();
  const { data: notifications } = useNotifications();

  const newNotifications = notifications
    ? notifications.filter((n) => !n.read).length
    : 0;

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
          <span className="text-primary-text text-right font-semibold">
            {userName}
          </span>
          <span className="text-right text-secondary-text">{jobTitle}</span>
        </div>
        <img
          className="rounded-xl border-1 border-border-color w-12 h-12 object-cover"
          src={avatarUrl || "/Logo-black-on-yellow.png"}
          alt="Profile Pic"
        />
      </div>
    </header>
  );
};

export default Header;
