import { BellIcon, DatabaseIcon, MonitorCogIcon, SettingsIcon, ShieldUserIcon, UserCogIcon } from "@/components/icons";

const SettingMenuStructure = [
  {
    name: "Organisation",
    path: "Organisation",
    icon: SettingsIcon,
    subMenu: [],
  },
  {
    name: "Users & permissions",
    path: "Users",
    icon: ShieldUserIcon,
    permission: "members.read",
    subMenu: [],
  },
  {
    name: "Account",
    path: "Account",
    icon: UserCogIcon,
    subMenu: [],
  },
  {
    name: "System Preferences",
    path: "System-Preferences",
    icon: MonitorCogIcon,
    subMenu: [],
  },
  {
    name: "Data Management",
    path: "Data-Management",
    icon: DatabaseIcon,
    permission: "lookups.manage",
    subMenu: [],
  },
  {
    name: "Notifications",
    path: "Notifications",
    icon: BellIcon,
    subMenu: [],
  },
  {
    name: "Admin",
    path: "Admin",
    icon: ShieldUserIcon,
    subMenu: [],
  },
];

export default SettingMenuStructure;
