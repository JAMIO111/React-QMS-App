import React from "react";
import NonConformanceCard from "./NonConformanceCard";
import ncmData from "/src/ncmData.json";

const NonConformanceGrid = () => {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      {ncmData.map((item, index) => {
        return (
          <NonConformanceCard
            key={index}
            id={item.id}
            title={item.title}
            description={item.description}
            status={item.status}
            date={item.date}
          />
        );
      })}
    </div>
  );
};

export default NonConformanceGrid;
