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
    path: "/QMS/Dashboard",
    subMenu: [],
  },
  {
    name: "Non-Conformance",
    icon: PiWarning,
    path: "/QMS/Non-Conformance",
    subMenu: [
      {
        name: "Internal",
        path: "/QMS/Non-Conformance/Internal",
      },
      {
        name: "Customer",
        path: "/QMS/Non-Conformance/External",
      },
      {
        name: "Supplier",
        path: "/QMS/QMS/Non-Conformance/Supplier",
      },
      {
        name: "Warranty",
        path: "/QMS/Non-Conformance/Warranty",
      },
      {
        name: "Audit",
        path: "/QMS/Non-Conformance/Audit",
      },
    ],
  },
  {
    name: "Projects",
    icon: BsFolder,
    path: "/QMS/Projects",
    subMenu: [],
  },
  {
    name: "Purchase Orders",
    icon: LiaFileInvoiceDollarSolid,
    path: "/QMS/Purchase-Orders",
    subMenu: [],
  },
  {
    name: "Inventory",
    icon: BsBoxes,
    path: "/QMS/Inventory",
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
    path: "/QMS/Human-Resources",
    subMenu: [],
  },
];
