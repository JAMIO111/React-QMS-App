import { BoxesIcon, ClipboardCheckIcon, ClipboardListIcon, GaugeIcon, LayoutDashboardIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";

export const menuStructure = [
  {
    name: "Dashboard",
    icon: LayoutDashboardIcon,
    path: "/Dashboard",
    subMenu: [],
  },
  {
    name: "Non-Conformance",
    icon: TriangleAlertIcon,
    permission: "ncr.read",
    path: "/Non-Conformance",
    subMenu: [
      { name: "Dashboard", path: "/Non-Conformance", end: true },
      { name: "Internal", path: "/Non-Conformance/Internal" },
      { name: "Customer", path: "/Non-Conformance/Customer" },
      { name: "Supplier", path: "/Non-Conformance/Supplier" },
    ],
  },
  {
    name: "In-Process Inspection",
    icon: ClipboardListIcon,
    permission: "inspection.read",
    path: "/Inspections",
    subMenu: [],
  },
  {
    name: "Process Control",
    icon: ClipboardCheckIcon,
    permission: "process_control.read",
    path: "/Process-Control",
    subMenu: [{ name: "Control Plans", path: "/Process-Control/Plans" }],
  },
  {
    name: "Calibration",
    icon: GaugeIcon,
    permission: "calibration.read",
    path: "/Calibration",
    subMenu: [
      { name: "Dashboard", path: "/Calibration", end: true },
      { name: "Gauges", path: "/Calibration/Gauges" },
    ],
  },
  {
    name: "Master Data",
    icon: BoxesIcon,
    permission: "master_data.read",
    path: "/Parts",
    subMenu: [
      { name: "Parts", path: "/Parts" },
      { name: "Part Families", path: "/Part-Families" },
      { name: "Machines", path: "/Machines" },
      { name: "Customers", path: "/Customers" },
      { name: "Suppliers", path: "/Suppliers" },
    ],
  },
  {
    name: "Human Resources",
    icon: UsersIcon,
    permission: "master_data.read",
    path: "/Human-Resources",
    subMenu: [],
  },
];
