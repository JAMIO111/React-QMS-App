import { GoDatabase } from "react-icons/go";
import { MdOutlineAdminPanelSettings } from "react-icons/md";
import { BsBell } from "react-icons/bs";
import { MdOutlineManageAccounts } from "react-icons/md";
import { TbDeviceDesktopCog } from "react-icons/tb";
import { BsGear } from "react-icons/bs";

const SettingMenuStructure = [
  {
    name: "General",
    path: "General",
    icon: BsGear,
    subMenu: [],
  },
  {
    name: "Account",
    path: "Account",
    icon: MdOutlineManageAccounts,
    subMenu: [],
  },
  {
    name: "System Preferences",
    path: "System-Preferences",
    icon: TbDeviceDesktopCog,
    subMenu: [],
  },
  {
    name: "Data Management",
    path: "Data-Management",
    icon: GoDatabase,
    subMenu: [],
  },
  {
    name: "Notifications",
    path: "Notifications",
    icon: BsBell,
    subMenu: [],
  },
  {
    name: "Admin",
    path: "Admin",
    icon: MdOutlineAdminPanelSettings,
    subMenu: [],
  },
];

export default SettingMenuStructure;
