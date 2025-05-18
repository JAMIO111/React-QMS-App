import { RxDashboard } from "react-icons/rx";
import { PiWarning } from "react-icons/pi";
import {
  BsFolder,
  BsGear,
  BsBoxes,
  BsQuestionCircle,
  BsPeople,
} from "react-icons/bs";
import { LiaFileInvoiceDollarSolid } from "react-icons/lia";

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
    path: "/Non-Conformance",
    subMenu: [
      {
        name: "Internal",
        path: "/Non-Conformance/Internal",
      },
      {
        name: "Customer",
        path: "/Non-Conformance/External",
      },
      {
        name: "Supplier",
        path: "/Non-Conformance/Supplier",
      },
      {
        name: "Warranty",
        path: "/Non-Conformance/Warranty",
      },
      {
        name: "Audit",
        path: "/Non-Conformance/Audit",
      },
    ],
  },
  {
    name: "Projects",
    icon: BsFolder,
    path: "/Projects",
    subMenu: [],
  },
  {
    name: "Purchase Orders",
    icon: LiaFileInvoiceDollarSolid,
    path: "/Purchase-Orders",
    subMenu: [],
  },
  {
    name: "Inventory",
    icon: BsBoxes,
    path: "/Inventory",
    subMenu: [
      {
        name: "Stock",
        path: "/Stock",
      },
      {
        name: "Stock Adjustment",
        path: "/Stock-Adjustment",
      },
      {
        name: "Part Maintenance",
        path: "/Part-Maintenance",
      },
    ],
  },
  {
    name: "Human Resources",
    icon: BsPeople,
    path: "/Human-Resources",
    subMenu: [],
  },
];
