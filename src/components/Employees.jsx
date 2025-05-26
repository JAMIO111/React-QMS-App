import React, { useState } from "react";
import EmployeeCard from "./EmployeeCard";
import { fetchAll } from "../api/supabaseApi";
import { useQuery } from "@tanstack/react-query";
import { useGlobalSearch } from "../contexts/SearchProvider";
import CTAButton from "./CTAButton";
import { IoAddOutline } from "react-icons/io5";
import { HiOutlinePencil } from "react-icons/hi2";

const Employees = () => {
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  console.log("Selected Employee:", selectedEmployee);
  const { data, error, isLoading } = useQuery({
    queryKey: ["Employees"],
    queryFn: () => fetchAll("Employees"),
    staleTime: 1000 * 60 * 60, // 1 hour
  });

  const { debouncedSearchTerm } = useGlobalSearch();

  const filteredData = debouncedSearchTerm
    ? data?.filter((employee) => {
        const term = debouncedSearchTerm.toLowerCase();
        return (
          employee.first_name?.toLowerCase().includes(term) ||
          employee.surname?.toLowerCase().includes(term) ||
          employee.job_title?.toLowerCase().includes(term)
        );
      })
    : data;

  const handleEmployeeClick = (employeeId) => {
    setSelectedEmployee((prev) => (prev === employeeId ? null : employeeId));
  };

  return (
    <div className="flex bg-primary-bg flex-1 overflow-auto flex-col gap-5 p-5">
      <div className="flex flex-row justify-between h-7 items-center">
        <p className="text-primary-text text-xl font-semibold pl-1">
          Employees
        </p>
        <div className="flex flex-row gap-2 pr-6">
          {selectedEmployee && (
            <CTAButton
              text={"Edit Details"}
              icon={HiOutlinePencil}
              type={"neutral"}
            />
          )}
          <CTAButton text={"Add Employee"} icon={IoAddOutline} type={"main"} />
        </div>
      </div>
      <div
        className={
          "grid xl:grid-cols-5 lg:grid-cols-4 md:grid-cols-3 sm:grid-cols-2 xs:grid-cols-1 gap-5 pr-3 overflow-auto"
        }>
        {isLoading && <div>Loading...</div>}
        {error && <div>Error: {error.message}</div>}
        {data &&
          filteredData.map((employee) => (
            <EmployeeCard
              onClick={() => handleEmployeeClick(employee.id)}
              selected={selectedEmployee === employee.id}
              key={employee.id}
              employee={employee}
              className="col-span-1 row-span-1"
            />
          ))}
      </div>
    </div>
  );
};

export default Employees;
