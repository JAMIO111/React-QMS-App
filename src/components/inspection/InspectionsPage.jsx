import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlusIcon } from "@/components/icons";
import { usePermissions } from "../../hooks/useQmsApi";
import { useInspections } from "../../hooks/useInspection";
import { TRIGGER_LABEL } from "../../lib/inspection";
import { formatDateTime } from "../../lib/processControl";
import { buttonClass, DataList, SearchBox, SelectField } from "../master-data/shared";
import { ResultBadge, StatusPill } from "./shared";

/** Register of in-process inspections, newest first. */
const InspectionsPage = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const query = useInspections({ q, status, result });
  const onSearch = useCallback((v) => setQ(v), []);

  const columns = useMemo(
    () => [
      {
        id: "reference",
        header: "Inspection",
        headerString: "Inspection",
        size: 130,
        cell: ({ row }) => (
          <Link to={`/Inspections/${row.original.id}`} className="table-row-item font-medium text-link-color hover:underline">
            {row.original.reference}
          </Link>
        ),
      },
      {
        id: "part",
        header: "Part",
        headerString: "Part",
        size: 200,
        cell: ({ row }) => (
          <span className="table-row-item">
            {row.original.part.partNumber} <span className="text-secondary-text">rev {row.original.partRevision}</span>
          </span>
        ),
      },
      { id: "operation", header: "Operation", headerString: "Operation", size: 100, cell: ({ row }) => <span className="table-row-item font-mono">{row.original.operationCode ?? "All"}</span> },
      {
        id: "plan",
        header: "Plan",
        headerString: "Control plan",
        size: 150,
        cell: ({ row }) => (
          <span className="table-row-item">
            {row.original.plan.planCode} <span className="text-secondary-text">rev {row.original.plan.revisionCode}</span>
          </span>
        ),
      },
      {
        id: "context",
        header: "Work order / lot",
        headerString: "Work order / lot",
        size: 170,
        cell: ({ row }) => <span className="table-row-item">{[row.original.workOrder, row.original.lot, row.original.serial].filter(Boolean).join(" · ") || "—"}</span>,
      },
      { id: "trigger", header: "Trigger", headerString: "Trigger", size: 130, cell: ({ row }) => <span className="table-row-item">{TRIGGER_LABEL[row.original.triggerType]}</span> },
      { id: "status", header: "Status", headerString: "Status", size: 120, cell: ({ row }) => <StatusPill status={row.original.status} /> },
      {
        id: "result",
        header: "Result",
        headerString: "Result",
        size: 110,
        cell: ({ row }) =>
          row.original.status === "in_progress" && row.original.failures ? (
            <span className="table-row-item text-xs text-error-color">{row.original.failures} failed so far</span>
          ) : (
            <ResultBadge result={row.original.result} />
          ),
      },
      { id: "started", header: "Started", headerString: "Started", size: 170, cell: ({ row }) => <span className="table-row-item">{formatDateTime(row.original.startedAt)}</span> },
      { id: "by", header: "Operator", headerString: "Operator", size: 150, cell: ({ row }) => <span className="table-row-item">{row.original.startedBy?.name ?? "—"}</span> },
    ],
    []
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-primary-text">In-process inspection</h1>
          <p className="text-sm text-secondary-text">Inspections recorded against the control plan in force, with every reading kept.</p>
        </div>
        {can("inspection.record") && (
          <Link to="/Inspections/new" className={`${buttonClass.primary} flex items-center gap-1`}>
            <PlusIcon className="h-4 w-4" /> Start inspection
          </Link>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <SearchBox label="Search reference, part, work order, lot or serial" onSearch={onSearch} />
        <SelectField
          label="Status"
          placeholder="Any"
          value={status}
          onChange={setStatus}
          options={[
            { value: "in_progress", label: "In progress" },
            { value: "completed", label: "Completed" },
            { value: "abandoned", label: "Abandoned" },
          ]}
          className="w-44"
        />
        <SelectField
          label="Result"
          placeholder="Any"
          value={result}
          onChange={setResult}
          options={[
            { value: "pass", label: "Pass" },
            { value: "fail", label: "Fail" },
          ]}
          className="w-36"
        />
      </div>
      <DataList
        storageKey="inspection:register"
        columns={columns}
        query={query}
        ariaLabel="Inspections"
        emptyMessage={q || status || result ? "No inspections match these filters." : "No inspections yet."}
        onOpen={(r) => navigate(`/Inspections/${r.id}`)}
      />
    </div>
  );
};

export default InspectionsPage;
