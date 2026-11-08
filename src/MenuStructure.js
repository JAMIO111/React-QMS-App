import { BoxesIcon, ClipboardCheckIcon, ClipboardListIcon, FactoryIcon, FileTextIcon, GaugeIcon, LayoutDashboardIcon, ListChecksIcon, TriangleAlertIcon } from "@/components/icons";

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
    module: "nonconformance",
    path: "/Non-Conformance",
    subMenu: [
      { name: "Dashboard", path: "/Non-Conformance", end: true },
      { name: "Internal", path: "/Non-Conformance/Internal" },
      { name: "Customer", path: "/Non-Conformance/Customer" },
      { name: "Supplier", path: "/Non-Conformance/Supplier" },
    ],
  },
  {
    name: "Corrective Actions (8D)",
    icon: ListChecksIcon,
    permission: "capa.read",
    path: "/CAPA",
    // badge: "my-actions" = how many 8D actions assigned to the signed-in person are still open (see Navbar)
    badge: "my-actions",
    subMenu: [
      { name: "All 8Ds", path: "/CAPA", end: true },
      { name: "My actions", path: "/CAPA/My-Actions", badge: "my-actions" },
    ],
  },
  {
    name: "In-Process Inspection",
    icon: ClipboardListIcon,
    permission: "inspection.read",
    module: "inspections",
    path: "/Inspections",
    subMenu: [],
  },
  {
    name: "Process Control",
    icon: ClipboardCheckIcon,
    permission: "process_control.read",
    module: "control_plans",
    path: "/Process-Control",
    subMenu: [
      { name: "Dashboard", path: "/Process-Control", end: true },
      { name: "Control Plans", path: "/Process-Control/Plans" },
      { name: "SPC Charts", path: "/Process-Control/SPC", permission: "spc.read" },
      { name: "SPC Alerts", path: "/Process-Control/Alerts", permission: "spc.read" },
      { name: "Machine & family analysis", path: "/Process-Control/Analysis", permission: "spc.read" },
    ],
  },
  {
    name: "Calibration",
    icon: GaugeIcon,
    permission: "calibration.read",
    module: "calibration",
    path: "/Calibration",
    subMenu: [
      { name: "Dashboard", path: "/Calibration", end: true },
      { name: "Gauges", path: "/Calibration/Gauges" },
    ],
  },
  {
    name: "Documentation",
    icon: FileTextIcon,
    permission: "documentation.read",
    path: "/Documentation",
    // badge: "my-alerts" = how many alerts addressed to the signed-in person still need acknowledging (see Navbar)
    badge: "my-alerts",
    subMenu: [
      { name: "My alerts", path: "/Documentation/My-Alerts", badge: "my-alerts" },
      { name: "Quality alerts", path: "/Documentation/Quality-Alerts" },
      { name: "Audits", path: "/Documentation/Audits", permission: "audits.read" },
    ],
  },
  {
    name: "Production",
    icon: FactoryIcon,
    permission: "production.read",
    path: "/Production",
    subMenu: [
      { name: "Orders", path: "/Production/Orders" },
      // `setting`: shown only while that organisation setting is not switched off
      { name: "Lots", path: "/Production/Lots", setting: "useLotsAndSerials" },
      { name: "Serial numbers", path: "/Production/Serials", setting: "useLotsAndSerials" },
      { name: "Traceability", path: "/Production/Traceability" },
    ],
  },
  {
    name: "Master Data",
    icon: BoxesIcon,
    permission: "master_data.read",
    path: "/Master-Data",
    subMenu: [
      { name: "Overview", path: "/Master-Data" },
      { name: "Parts", path: "/Parts" },
      { name: "Part Families", path: "/Part-Families" },
      { name: "Machines", path: "/Machines" },
      { name: "Customers", path: "/Customers" },
      { name: "Suppliers", path: "/Suppliers" },
      { name: "Employees", path: "/Employees" },
    ],
  },
];
