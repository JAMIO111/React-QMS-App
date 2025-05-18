import React, { useState } from "react";
import ToastNotification from "./ToastNotification";
import Skeleton from "./Skeleton";

const Dashboard = () => {
  const [showToast, setShowToast] = useState(false);
  return (
    <div className="p-4 bg-secondary-bg">
      {showToast && (
        <ToastNotification
          type="info"
          title="Deletion Failure"
          message="We were unable to delete the record"
          onClose={() => setShowToast(false)}
        />
      )}
      <button onClick={() => setShowToast(true)}>Show toast</button>
      <div className="flex gap-5 w-100 flex-col justify-center items-center">
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    </div>
  );
};

export default Dashboard;
