import { BsBell } from "react-icons/bs";
import { GoMail } from "react-icons/go";
import HeaderIcon from "./HeaderIcon";
import SearchBar from "./ui/SearchBar";
import { useUser } from "../contexts/UserProvider";
import { useNotification } from "../contexts/NotificationProvider";
import { useNotifications } from "../hooks/useNotifications";

const Header = () => {
  const { profile } = useUser();
  const userName = profile
    ? `${profile.first_name} ${profile.surname}`
    : "User";
  const jobTitle = profile ? profile.job_title : "Job Title";
  const { openPane } = useNotification();
  const { data: notifications } = useNotifications();

  const newNotifications = notifications
    ? notifications.filter((n) => !n.read).length
    : 0;

  return (
    <header className="flex justify-between items-center border-b-1 border-border-color bg-secondary-bg px-4">
      <SearchBar />
      <div className="flex justify-between items-center py-2 gap-3">
        <HeaderIcon icon={GoMail} top={7} right={3} />
        <button onClick={() => openPane()}>
          <HeaderIcon
            showBadge={newNotifications > 0}
            icon={BsBell}
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
          src={profile?.avatar ? profile.avatar : "/Logo-black-on-yellow.png"}
          alt="Profile Pic"
        />
      </div>
    </header>
  );
};

export default Header;
