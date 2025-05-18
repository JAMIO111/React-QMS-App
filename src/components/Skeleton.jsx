import React from "react";

const Skeleton = () => {
  return (
    <div className="w-full bg-border-color/50 h-16 rounded-xl px-5 gap-5 flex flex-row items-center p-3 ">
      <div className="w-12 h-10 rounded-full bg-border-dark-color/70 shimmer"></div>
      <div className="flex w-full h-full flex-col justify-between items-center">
        <div className="w-full h-3 bg-border-dark-color/70 rounded-full shimmer"></div>
        <div className="w-full h-3 bg-border-dark-color/70 rounded-full shimmer"></div>
      </div>
    </div>
  );
};

export default Skeleton;
