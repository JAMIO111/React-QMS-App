import React from "react";

const DailyCalendarItems = ({ date, tasks }) => {
  return (
    <div className="flex justify-center items-center min-w-[50vw] min-h-[60vh] max-h-80vh overflow-y-auto p-4">
      {tasks.length ? (
        tasks.map((task) => (
          <div key={task.id}>
            <span>{task.title}</span>
            <span>{task.time}</span>
          </div>
        ))
      ) : (
        <div className="flex flex-col justify-center items-center gap-4">
          <p className="text-xl font-semibold text-primary-text">
            No tasks for this day
          </p>
          <p className="text-secondary-text">
            Finally some downtime? Kick your feet up and relax!
          </p>
        </div>
      )}
    </div>
  );
};

export default DailyCalendarItems;
