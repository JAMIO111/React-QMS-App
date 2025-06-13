import ShieldBadge from "./ShieldBadge";

const colors = {
  1: {
    bg: "bg-cyan-400/30",
    border: "border-cyan-500",
    text: "text-cyan-600",
    stage: "TEAM",
  },
  2: {
    bg: "bg-blue-400/30",
    border: "border-blue-500",
    text: "text-blue-600",
    stage: "DEFINE",
  },
  3: {
    bg: "bg-purple-400/30",
    border: "border-purple-500",
    text: "text-purple-600",
    stage: "CONTAIN",
  },
  4: {
    bg: "bg-pink-400/30",
    border: "border-pink-500",
    text: "text-pink-600",
    stage: "ANALYZE",
  },
  5: {
    bg: "bg-red-400/30",
    border: "border-red-500",
    text: "text-red-600",
    stage: "RESOLVE",
  },
  6: {
    bg: "bg-orange-400/30",
    border: "border-orange-500",
    text: "text-orange-600",
    stage: "IMPLEMENT",
  },
  7: {
    bg: "bg-yellow-400/30",
    border: "border-yellow-500",
    text: "text-yellow-600",
    stage: "PREVENT",
  },
  8: {
    bg: "bg-green-400/30",
    border: "border-green-500",
    text: "text-green-600",
    stage: "CLOSURE",
  },
  0: {
    bg: "bg-gray-400/30",
    border: "border-gray-500",
    text: "text-gray-600",
    stage: "UNKNOWN",
  },
};

const BadgeGroup = ({ stage }) => {
  const colorSet = colors[stage] || colors[0];
  const stageText = colorSet.stage;

  return (
    <div
      className={`
        border-2 rounded-xl px-3 flex flex-row items-center justify-center w-fit
        ${colorSet.bg} bg-opacity-10 
        ${colorSet.border}
      `}>
      <p className={`mr-3 text-2xl font-semibold ${colorSet.text}`}>
        {stageText}
      </p>
      <div className={`${colorSet.border} border h-16 mr-8`}></div>
      <div className="flex gap-5 items-center justify-center mr-4">
        {Array.from({ length: stage }, (_, i) => (
          <div className="scale-70" key={i + 1}>
            <ShieldBadge number={stage === i + 1 ? stage : 0} />
          </div>
        ))}
      </div>
    </div>
  );
};

export default BadgeGroup;
