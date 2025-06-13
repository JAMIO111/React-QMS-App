import React from "react";
import { BsFillShieldFill, BsShield } from "react-icons/bs"; // don't forget to import these
import clsx from "clsx";

const colors = {
  1: {
    "color-1": "fill-cyan-400",
    "color-2": "fill-cyan-500",
    "color-3": "fill-cyan-600",
    stage: "Team",
  },
  2: {
    "color-1": "fill-blue-400",
    "color-2": "fill-blue-500",
    "color-3": "fill-blue-600",
    stage: "Define",
  },
  3: {
    "color-1": "fill-purple-400",
    "color-2": "fill-purple-500",
    "color-3": "fill-purple-600",
    stage: "Contain",
  },
  4: {
    "color-1": "fill-pink-400",
    "color-2": "fill-pink-500",
    "color-3": "fill-pink-600",
    stage: "Analyze",
  },
  5: {
    "color-1": "fill-red-400",
    "color-2": "fill-red-500",
    "color-3": "fill-red-600",
    stage: "Resolve",
  },
  6: {
    "color-1": "fill-orange-400",
    "color-2": "fill-orange-500",
    "color-3": "fill-orange-600",
    stage: "Implement",
  },
  7: {
    "color-1": "fill-yellow-400",
    "color-2": "fill-yellow-500",
    "color-3": "fill-yellow-600",
    stage: "Prevent",
  },
  8: {
    "color-1": "fill-green-400",
    "color-2": "fill-green-500",
    "color-3": "fill-green-600",
    stage: "Closure",
  },
  0: {
    "color-1": "fill-gray-400",
    "color-2": "fill-gray-500",
    "color-3": "fill-gray-600",
  },
};

const ShieldBadge = ({ number = 4 }) => {
  // Fallback to a default color set if number not found
  const colorSet = colors[number] || colors[4];

  return (
    <div
      name={colorSet.stage}
      className="relative flex flex-row justify-center items-center">
      <BsFillShieldFill
        className={clsx("absolute w-17 h-17", colorSet["color-1"])}
      />
      <BsShield className={clsx("absolute w-15 h-15", colorSet["color-3"])} />
      <BsShield className={clsx("absolute w-16 h-16", colorSet["color-2"])} />
      <span className="text-2xl font-semibold text-white absolute pb-1">
        D{number}
      </span>
    </div>
  );
};

export default ShieldBadge;
