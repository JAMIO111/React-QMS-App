import { BellIcon, CreditCardIcon, ClipboardListIcon, DatabaseIcon, GaugeIcon, MonitorCogIcon, SettingsIcon, ShieldUserIcon, UserCogIcon } from "@/components/icons";

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
    name: "Subscription & billing",
    path: "Subscription",
    icon: CreditCardIcon,
    permission: "subscription.read",
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
    name: "Calibration",
    path: "Calibration",
    icon: GaugeIcon,
    permission: "calibration.read",
    subMenu: [],
  },
  {
    name: "Process control",
    path: "Process-Control",
    icon: ClipboardListIcon,
    permission: "process_control.read",
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
