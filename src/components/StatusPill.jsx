import { useStatusOptions } from "@/hooks/useCategoryOptions";

const StatusPill = ({ status, width = "w-full" }) => {
  const { data: statusOptions, isLoading } = useStatusOptions();

  const statusObj = statusOptions?.find((s) => s.id === status);

  return (
    <div className={width}>
      <div
        style={{
          color: statusObj?.color,
          borderColor: statusObj?.color,
          backgroundColor: statusObj?.color
            ? `${statusObj.color}20`
            : undefined,
        }}
        className="font-semibold border text-center truncate overflow-ellipsis rounded-lg px-3 py-1">
        <p>{isLoading ? "Loading..." : statusObj?.name ?? "Unknown"}</p>
      </div>
    </div>
  );
};

export default StatusPill;
