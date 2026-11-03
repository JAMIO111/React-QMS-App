import { RxDashboard } from "react-icons/rx";
import { PiWarning } from "react-icons/pi";
import { BsPeople } from "react-icons/bs";

export const menuStructure = [
  {
    name: "Dashboard",
    icon: RxDashboard,
    path: "/Dashboard",
    subMenu: [],
  },
  {
    name: "Non-Conformance",
    icon: PiWarning,
    path: "/Non-Conformance/Internal",
    subMenu: [
      { name: "Internal", path: "/Non-Conformance/Internal" },
      { name: "Customer", path: "/Non-Conformance/Customer" },
      { name: "Supplier", path: "/Non-Conformance/Supplier" },
    ],
  },
  {
    name: "Human Resources",
    icon: BsPeople,
    path: "/Human-Resources",
    subMenu: [],
  },
];
