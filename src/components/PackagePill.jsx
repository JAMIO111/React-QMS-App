import React from "react";

const PackagePill = ({ maintPackage, className }) => {
  if (!maintPackage) return null;

  const styles = {
    gold: "bg-yellow-500/70 border-yellow-500 text-black",
    silver: "bg-gray-300/70 border-gray-300 text-black",
    bronze: "bg-orange-700/70 border-orange-700 text-white",
    unmanaged: "bg-black/50 border-black text-white",
  };

  // Map IDs to styles (adjust IDs to your actual values)
  const idToStyle = {
    1: styles.gold,
    2: styles.silver,
    3: styles.bronze,
    0: styles.unmanaged,
  };

  const selectedStyle = idToStyle[maintPackage.tier] || styles.gold; // fallback

  return (
    <div
      className={`${className} rounded-xl px-3 py-1 border ${selectedStyle}`}>
      <p className="text-xl font-semibold">{maintPackage?.name}</p>
    </div>
  );
};

export default PackagePill;
