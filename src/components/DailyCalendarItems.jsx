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
        <div className="text-secondary-text">No tasks for this day</div>
      )}
    </div>
  );
};

export default DailyCalendarItems;
