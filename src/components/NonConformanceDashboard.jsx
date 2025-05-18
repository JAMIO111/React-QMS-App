import React from "react";
import RadialGauge from "./charts/RadialGauge";

const MosaicTile = ({ children, className }) => (
  <div className={`bg-white shadow rounded-xl p-4 ${className}`}>
    {children}
  </div>
);

const NonConformanceDashboard = () => {
  return (
    <div className="p-4 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 auto-rows-[150px]">
      <MosaicTile className="col-span-2 row-span-2 flex items-center justify-center text-xl font-bold">
        Main Chart
      </MosaicTile>
      <MosaicTile>Stat A</MosaicTile>
      <MosaicTile>Stat B</MosaicTile>

      <MosaicTile className="row-span-2">Activity Feed</MosaicTile>
      <MosaicTile className="row-span-2">Stat C</MosaicTile>
      <MosaicTile>Stat D</MosaicTile>
      <MosaicTile>Mini Chart</MosaicTile>
    </div>
  );
};

export default NonConformanceDashboard;
