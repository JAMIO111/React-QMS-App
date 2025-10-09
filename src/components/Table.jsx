import { useState, useEffect, useRef } from "react";
import { flexRender } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { PiArrowsDownUpLight } from "react-icons/pi";
import { useParams } from "react-router-dom";

const Table = ({
  table,
  onSelectedRowsChange,
  isLoading,
  data,
  resizedColumns,
}) => {
  const { type } = useParams();
  const navigate = useNavigate();
  const selectAllCheckbox = useRef(null);
  const [selectedRowId, setSelectedRowId] = useState(null);
  const sortClickRef = useRef(null);

  const getColumnStyle = (column, isResized) => {
    return isResized
      ? {
          width: `${column.getSize()}px`,
          minWidth: `${column.getSize()}px`,
          maxWidth: `${column.getSize()}px`,
          flex: "1 1 auto",
        }
      : {
          flexGrow: column.columnDef?.meta?.flex ?? 1,
          flexShrink: 1,
          flexBasis: 0,
          minWidth: column.columnDef?.minSize ?? 30,
          maxWidth: column.columnDef?.maxSize ?? 1000,
        };
  };

  const getAlignmentClass = (column) => {
    const pos = column.columnDef?.meta?.flexPos;
    return pos === "center"
      ? "justify-center"
      : pos === "right"
      ? "justify-end"
      : "justify-start";
  };

  useEffect(() => {
    const all = table.getIsAllPageRowsSelected();
    const some = table.getIsSomePageRowsSelected();

    if (selectAllCheckbox.current) {
      selectAllCheckbox.current.indeterminate = !all && some;
    }
  }, [table.getState().rowSelection, table]);

  useEffect(() => {
    if (onSelectedRowsChange) {
      const selected = table
        .getSelectedRowModel()
        .rows.map((row) => row.original);
      onSelectedRowsChange(selected);
    }
  }, [table.getState().rowSelection, table, onSelectedRowsChange]);

  return (
    <div className="relative w-full h-full">
      <div className="w-full h-full overflow-x-auto">
        <div className="min-w-max overflow-x-hidden flex flex-col h-full">
          {/* Header */}
          <div className="sticky top-0 z-10 bg-primary-bg shadow-sm">
            {table.getHeaderGroups().map((headerGroup) => (
              <div
                key={headerGroup.id}
                className="flex border-b border-border-color">
                {headerGroup.headers.map((header) => {
                  const column = header.column;
                  const isResized = resizedColumns?.has(column.id);

                  return (
                    <div
                      key={header.id}
                      className={`relative hoverable-header group flex border-r border-border-color text-secondary-text px-2 py-1 text-center flex-1 ${
                        column.getCanSort()
                          ? "cursor-pointer"
                          : "cursor-default"
                      }`}
                      style={getColumnStyle(column, isResized)}
                      onMouseDown={() => {
                        if (column.getCanSort()) {
                          sortClickRef.current = column.id;
                        }
                      }}
                      onMouseUp={(e) => {
                        if (
                          column.getCanSort() &&
                          sortClickRef.current === column.id
                        ) {
                          column.getToggleSortingHandler()?.(e);
                        }
                        sortClickRef.current = null;
                      }}
                      onMouseLeave={() => {
                        sortClickRef.current = null;
                      }}>
                      {!header.isPlaceholder && (
                        <div
                          className={`flex items-center w-full gap-1 text-primary-text ${getAlignmentClass(
                            column
                          )}`}>
                          <div className="min-w-0 flex-1 w-fit">
                            <span className="truncate block whitespace-nowrap overflow-hidden text-ellipsis">
                              {flexRender(
                                column.columnDef.header,
                                header.getContext()
                              )}
                            </span>
                          </div>

                          {column.getCanSort() && (
                            <span className="transition-opacity duration-150">
                              {column.getIsSorted() === "asc" &&
                                column.columnDef.sortIconAsc}
                              {column.getIsSorted() === "desc" &&
                                column.columnDef.sortIconDesc}
                              {!column.getIsSorted() && (
                                <span className="opacity-0 group-hover:opacity-100">
                                  <PiArrowsDownUpLight className="h-5 w-5" />
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      )}
                      {column.getCanResize() && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          onTouchStart={(e) => e.stopPropagation()}
                          className="resizer-hit-area">
                          <div
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              column.getResizeHandler()(e);
                            }}
                            onTouchStart={(e) => {
                              e.stopPropagation();
                              column.getResizeHandler()(e);
                            }}
                            className={`resizer ${
                              column.getIsResizing() ? "isResizing" : ""
                            }`}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Rows */}
          <div className="relative h-full">
            <div className="absolute inset-0 overflow-y-auto overflow-x-hidden">
              <div className="min-w-max">
                {!isLoading && data.length === 0 && (
                  <div className="p-6 text-center text-secondary-text italic select-none">
                    No records found.
                  </div>
                )}

                {table.getRowModel().rows.map((row) => {
                  const isSelected = selectedRowId === row.id;
                  return (
                    <div
                      key={row.id}
                      onClick={() =>
                        setSelectedRowId((prev) =>
                          prev === row.id ? null : row.id
                        )
                      }
                      className={`flex border-b border-border-color ${
                        isSelected
                          ? "bg-brand-primary/10 hover:bg-brand-primary/20"
                          : "hover:bg-hover-menu-color"
                      }`}>
                      {row.getVisibleCells().map((cell) => {
                        const column = cell.column;
                        const isResized = resizedColumns?.has(column.id);
                        return (
                          <div
                            key={cell.id}
                            onDoubleClick={(e) => {
                              if (column.id !== "__select") {
                                e.stopPropagation();
                                navigate(
                                  `/Non-Conformance/${type}/Edit-NC-${row.original.id}`
                                );
                              }
                            }}
                            className={`border-r py-1 ${
                              column.getIsResizing()
                                ? "border-cta-color"
                                : "border-border-color"
                            } flex px-2 ${getAlignmentClass(column)} flex-1`}
                            style={getColumnStyle(column, isResized)}>
                            {flexRender(
                              column.columnDef.cell,
                              cell.getContext()
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Table;
