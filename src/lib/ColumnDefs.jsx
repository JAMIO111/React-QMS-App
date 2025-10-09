import { BsSortNumericUp } from "react-icons/bs";
import { BsSortUp } from "react-icons/bs";
import { BsSortDownAlt } from "react-icons/bs";
import StatusPill from "../components/StatusPill";
import { format } from "date-fns";
import {
  BsSortNumericUpAlt,
  BsSortNumericDownAlt,
  BsSortAlphaDown,
  BsSortAlphaUpAlt,
  BsBox,
  BsQrCode,
  BsCurrencyPound,
} from "react-icons/bs";
import { IoCalendarOutline, IoPeopleOutline } from "react-icons/io5";
import { PiStack } from "react-icons/pi";
import { AiOutlineTag } from "react-icons/ai";
import { CiTextAlignCenter } from "react-icons/ci";
import { LuCircleDashed } from "react-icons/lu";

export const getColumnsForNcType = (ncType = "Internal") => {
  const baseColumns = [
    {
      id: "ncm_id",
      accessorKey: "ncm_id",
      headerString: "ID",
      header: <div className="table-header">ID #</div>,
      cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
      size: 80,
      minSize: 50, // Reduced min size for more flexibility
      maxSize: 150, // Increased max size for wider view
    },
    {
      id: "created_at",
      accessorKey: "created_at",
      headerString: "Date",
      header: (
        <div className="table-header">
          <IoCalendarOutline className="shrink-0" /> Date
        </div>
      ),
      cell: (info) => (
        <div className="table-row-item">
          {format(new Date(info.getValue()), "dd MMM yy")}
        </div>
      ),
      size: 110,
      minSize: 70, // Slightly smaller min size
      maxSize: 180, // Larger max for longer dates if needed
    },
    {
      id: "part_number",
      accessorKey: "part_number",
      headerString: "Part No.",
      header: (
        <div className="table-header">
          <BsQrCode className="shrink-0" /> Part No.
        </div>
      ),
      cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
      size: 120,
      minSize: 80,
      maxSize: 300, // Allow wider to see full part numbers
    },
    {
      id: "quantity_defective",
      accessorKey: "quantity_defective",
      headerString: "Quantity",
      header: (
        <div className="table-header-number">
          <PiStack className="shrink-0" /> Qty
        </div>
      ),
      cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
      size: 90,
      minSize: 50,
      maxSize: 140,
      meta: {
        flexPos: "center",
      },
    },
    {
      id: "failure_mode_name",
      accessorKey: "failure_mode_name",
      headerString: "Failure Mode",
      header: (
        <div className="table-header">
          <AiOutlineTag className="shrink-0" /> Failure Mode
        </div>
      ),
      cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
      size: 180,
      minSize: 120,
      maxSize: 350,
    },
    {
      id: "sub_failure_mode_name",
      accessorKey: "sub_failure_mode_name",
      headerString: "Sub Failure Mode",
      header: (
        <div className="table-header">
          <AiOutlineTag className="shrink-0" /> Sub Failure Mode
        </div>
      ),
      cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
      size: 180,
      minSize: 120,
      maxSize: 350,
    },
    {
      id: "status",
      accessorKey: "status",
      headerString: "Status",
      header: (
        <div className="table-header-number">
          <LuCircleDashed className="shrink-0" /> Status
        </div>
      ),
      cell: (info) => (
        <div className="table-row-item">
          <StatusPill status={info.getValue()} />
        </div>
      ),
      size: 120,
      minSize: 90,
      maxSize: 180,
      meta: {
        flexPos: "center",
      },
    },
    {
      id: "description",
      accessorKey: "description",
      headerString: "Description",
      header: (
        <div className="table-header">
          <CiTextAlignCenter className="shrink-0" /> Description
        </div>
      ),
      cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
      enableSorting: false,
      size: 300,
      minSize: 150,
      maxSize: 600, // Allow very wide for verbose descriptions
      meta: {
        flex: 2,
      },
    },
    {
      id: "total_cost",
      accessorKey: "total_cost",
      headerString: "Total Cost",
      header: (
        <div className="table-header-number">
          <BsCurrencyPound className="shrink-0" /> Total Cost
        </div>
      ),
      cell: (info) => {
        return (
          <div className="table-row-item text-right">
            {new Intl.NumberFormat("en-GB", {
              style: "currency",
              currency: "GBP",
            }).format(info.getValue())}
          </div>
        );
      },
      size: 120,
      minSize: 90,
      maxSize: 250,
      meta: {
        flexPos: "right",
      },
    },
  ];

  // Type specific columns with adjusted min/max sizes
  const typeSpecific = {
    Internal: [
      {
        id: "customer_display_name",
        accessorKey: "customer_display_name",
        headerString: "Customer",
        header: (
          <div className="table-header">
            <IoPeopleOutline className="shrink-0" /> Customer
          </div>
        ),
        cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
        size: 180,
        minSize: 120,
        maxSize: 350,
      },
      {
        id: "work_order",
        accessorKey: "work_order",
        headerString: "Work Order",
        header: (
          <div className="table-header">
            <BsBox className="shrink-0" /> Work Order
          </div>
        ),
        cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
        size: 150,
        minSize: 100,
        maxSize: 300,
      },
    ],
    Customer: [
      {
        id: "claim_ref",
        accessorKey: "claim_ref",
        headerString: "Claim Ref.",
        header: (
          <div className="table-header">
            <IoPeopleOutline className="shrink-0" /> Claim Ref.
          </div>
        ),
        cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
        size: 180,
        minSize: 120,
        maxSize: 350,
      },
      {
        id: "customer_display_name",
        accessorKey: "customer_display_name",
        headerString: "Customer",
        header: (
          <div className="table-header">
            <IoPeopleOutline className="shrink-0" /> Customer
          </div>
        ),
        cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
        size: 180,
        minSize: 120,
        maxSize: 350,
      },
      {
        id: "work_order",
        accessorKey: "work_order",
        headerString: "Work Order",
        header: (
          <div className="table-header">
            <BsBox className="shrink-0" /> Work Order
          </div>
        ),
        cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
        size: 150,
        minSize: 100,
        maxSize: 300,
      },
    ],
    Supplier: [
      {
        id: "supplier_name",
        accessorKey: "supplier_name",
        headerString: "Supplier",
        header: (
          <div className="table-header">
            <IoPeopleOutline className="shrink-0" /> Supplier
          </div>
        ),
        cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
        size: 180,
        minSize: 120,
        maxSize: 350,
      },
      {
        id: "purchase_order",
        accessorKey: "purchase_order",
        headerString: "Purchase Order",
        header: (
          <div className="table-header">
            <BsBox className="shrink-0" /> Purchase Order
          </div>
        ),
        cell: (info) => <div className="table-row-item">{info.getValue()}</div>,
        size: 180,
        minSize: 120,
        maxSize: 350,
      },
    ],
  };

  // Insert the specific columns after "created_at"
  const insertAfter = "created_at";
  const baseIndex = baseColumns.findIndex((col) => col.id === insertAfter);

  const injectedColumns = [...baseColumns];
  if (typeSpecific[ncType]?.length && baseIndex !== -1) {
    injectedColumns.splice(baseIndex + 1, 0, ...typeSpecific[ncType]);
  }

  return injectedColumns;
};
