import { RxDashboard } from "react-icons/rx";
import { PiWarning } from "react-icons/pi";
import {
  BsFolder,
  BsGear,
  BsBoxes,
  BsQuestionCircle,
  BsPeople,
  BsHouse,
} from "react-icons/bs";
import { LiaFileInvoiceDollarSolid } from "react-icons/lia";
import { IoReceiptOutline } from "react-icons/io5";
import { BsHouseGear } from "react-icons/bs";
import { HiOutlineWrenchScrewdriver } from "react-icons/hi2";
import { IoCalendarOutline } from "react-icons/io5";

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
        path: "/Non-Conformance/Customer",
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
    name: "Bookings",
    icon: IoReceiptOutline,
    path: "/Bookings",
    subMenu: [
      {
        name: "New Booking",
        path: "/Bookings/New-Booking",
      },
      {
        name: "Existing Bookings",
        path: "/Bookings/View-Existing",
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
        path: "/Inventory/Stock",
      },
      {
        name: "Stock Adjustment",
        path: "/Inventory/Stock-Adjustment",
      },
      {
        name: "Item",
        path: "/Inventory/Item",
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
