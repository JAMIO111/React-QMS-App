import { BoxesIcon, LayoutDashboardIcon, TriangleAlertIcon, UsersIcon } from "@/components/icons";

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
    path: "/Non-Conformance/Internal",
    subMenu: [
      { name: "Internal", path: "/Non-Conformance/Internal" },
      { name: "Customer", path: "/Non-Conformance/Customer" },
      { name: "Supplier", path: "/Non-Conformance/Supplier" },
    ],
  },
  {
    name: "Master Data",
    icon: BoxesIcon,
    permission: "master_data.read",
    path: "/Parts",
    subMenu: [
      { name: "Parts", path: "/Parts" },
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
