import StatusPill from "../StatusPill";

const StatusPreviewCard = ({ status, mode }) => {
  const bgColor = mode === "light" ? "rgba(248,248,248,1)" : "rgba(24,24,24,1)";

  return (
    <div
      style={{ backgroundColor: bgColor }}
      className="w-48 h-1/2 flex items-center justify-center p-4">
      <StatusPill status={status} />
    </div>
  );
};

export default StatusPreviewCard;
