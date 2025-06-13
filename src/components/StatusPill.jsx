const StatusPill = ({ status, width = "w-full" }) => {
  return (
    <div className={width}>
      <div
        style={{
          color: status?.color,
          borderColor: status?.color,
          backgroundColor: `${status?.color}20`,
        }}
        className={`font-semibold border text-center rounded-lg px-3 py-1`}>
        <p>{status?.name ?? "Loading..."}</p>
      </div>
    </div>
  );
};

export default StatusPill;
