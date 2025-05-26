import React from "react";

const EmployeeCard = ({ employee, selected, onClick }) => {
  return (
    <div
      onClick={onClick}
      className={`${
        selected ? "border-brand-primary" : ""
      } flex flex-col items-center justify-center bg-primary-bg border border-border-color rounded-xl drop-shadow-sm drop-shadow-shadow-color gap-2 py-6`}>
      {employee.avatar ? (
        <img
          src={employee.avatar}
          alt={`${employee.name} ${employee.surname}'s profile`}
          className="w-24 h-24 border border-primary-text object-cover rounded-full mb-4"
        />
      ) : (
        <div className="w-24 h-24 bg-secondary-bg rounded-full border border-primary-text mb-4">
          <div className="flex items-center justify-center w-full h-full text-3xl font-bold text-secondary-text">
            {employee.first_name.charAt(0)}
            {employee.surname.charAt(0)}
          </div>
        </div>
      )}
      <h2 className="text-lg text-center flex items-center text-primary-text">
        {employee.first_name} {employee.surname}
      </h2>
      <p className="text-secondary-text text-center flex items-center text-sm">
        {employee.job_title}
      </p>
    </div>
  );
};

export default EmployeeCard;
