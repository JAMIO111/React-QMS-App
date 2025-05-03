export const menuStructure = [
  {
    name: "General",
    icon: RxDashboard,
    path: "/",
    subMenu: [],
  },
  {
    name: "Non-Conformance",
    icon: PiWarning,
    path: "/Non-Conformance",
    subMenu: [
      {
        name: "Internal",
        path: "/Internal",
      },
      {
        name: "Customer",
        path: "/External",
      },
      {
        name: "Supplier",
        path: "/Supplier",
      },
      {
        name: "Warranty",
        path: "/Warranty",
      },
      {
        name: "Audit",
        path: "/Audit",
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
