import React from "react";
import NonConformanceCard from "./NonConformanceCard";
import ncmData from "/src/ncmData.json";

const NonConformanceGrid = () => {
  return (
    <div className="grid pr-2 grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto h-full">
      {ncmData.map((item, index) => {
        return <NonConformanceCard key={index} item={item} />;
      })}
    </div>
  );
};

export default NonConformanceGrid;
