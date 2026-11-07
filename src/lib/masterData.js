import { BoxesIcon, FactoryIcon, LayersIcon, PackageIcon, UserIcon, UsersIcon } from "@/components/icons";

/** The six kinds of master data on the overview: label, register and icon. */
export const KINDS = {
  parts: { label: "Parts", one: "Part", to: "/Parts", icon: PackageIcon },
  partFamilies: { label: "Part families", one: "Part family", to: "/Part-Families", icon: LayersIcon },
  machines: { label: "Machines", one: "Machine", to: "/Machines", icon: FactoryIcon },
  customers: { label: "Customers", one: "Customer", to: "/Customers", icon: UsersIcon },
  suppliers: { label: "Suppliers", one: "Supplier", to: "/Suppliers", icon: BoxesIcon },
  employees: { label: "Employees", one: "Employee", to: "/Employees", icon: UserIcon },
};

export const REVISION_STATUS = {
  draft: { label: "Draft", color: "var(--chart-neutral)" },
  released: { label: "Released", color: "var(--chart-series-3)" },
  superseded: { label: "Superseded", color: "var(--chart-series-1)" },
  obsolete: { label: "Obsolete", color: "var(--chart-critical)" },
};
