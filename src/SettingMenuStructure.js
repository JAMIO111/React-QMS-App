import {
  BellIcon,
  CreditCardIcon,
  DatabaseIcon,
  HandshakeIcon,
  MonitorCogIcon,
  PlugIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldUserIcon,
  UserCogIcon,
  WorkflowIcon,
} from "@/components/icons";

const SettingMenuStructure = [
  {
    name: "Organisation",
    path: "Organisation",
    icon: SettingsIcon,
    subMenu: [],
  },
  {
    name: "Account",
    path: "Account",
    icon: UserCogIcon,
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
    name: "Security",
    path: "Security",
    icon: ShieldCheckIcon,
    permission: "security.read",
    subMenu: [],
  },
  {
    name: "External access",
    path: "External-Access",
    icon: HandshakeIcon,
    permission: "external_access.read",
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
    // Any module the person may read: Non-conformance, Calibration, Process control, Audits, Supplier quality (tabs inside).
    permission: ["ncr.read", "calibration.read", "process_control.read", "audits.read", "supplier_quality.read", "competence.read", "documentation.manage", "risk.read", "custom_fields.manage"],
    subMenu: [],
  },
  {
    name: "Workflows",
    path: "Workflows",
    icon: WorkflowIcon,
    permission: "workflows.read",
    subMenu: [],
  },
  {
    name: "Integrations",
    path: "Integrations",
    icon: PlugIcon,
    permission: "integrations.read",
    subMenu: [],
  },
  {
    name: "Notifications",
    path: "Notifications",
    icon: BellIcon,
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
    name: "Admin",
    path: "Admin",
    icon: ShieldUserIcon,
    subMenu: [],
  },
];

export default SettingMenuStructure;
