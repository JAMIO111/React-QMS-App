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
    name: "Client Management",
    icon: BsHouseGear,
    path: "/Client-Management",
    subMenu: [
      {
        name: "Properties",
        path: "/Client-Management/Properties",
      },
      {
        name: "Owners",
        path: "/Client-Management/Owners",
      },
    ],
  },
  {
    name: "Maintenance",
    icon: HiOutlineWrenchScrewdriver,
    path: "/Maintenance",
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
    subMenu: [
      {
        name: "Employees",
        path: "/Human-Resources/Employees",
      },
      {
        name: "Payroll",
        path: "/Human-Resources/Payroll",
      },
      {
        name: "Holidays",
        path: "/Human-Resources/Holidays",
      },
      {
        name: "Training",
        path: "/Human-Resources/Training",
      },
    ],
  },
  {
    name: "Calendar",
    icon: IoCalendarOutline,
    path: "/Calendar",
  },
];
