import React from "react";

const DashboardTable = () => {
  return (
    <div className="flex flex-col px-4 pt-2 pb-4 h-full w-full">
      <div className="flex flex-row justify-between items-center mb-2 px-2">
        <h2 className="text-primary-text text-lg">My Actions</h2>
        <p className="text-secondary-text text-sm">View All</p>
      </div>
      <div className="border border-border-color rounded-xl overflow-hidden">
        <table>
          <thead>
            <tr className="border-b border-border-color">
              <th className="px-4 py-2 text-left text-primary-text">Date</th>
              <th className="px-4 py-2 text-left text-primary-text">Action</th>
              <th className="px-4 py-2 text-left text-primary-text">Status</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            <tr className="border-b border-border-color">
              <td className="px-4 py-2 text-secondary-text">23/10/25</td>
              <td className="px-4 py-2 text-secondary-text">
                Reviewed Non-Conformance
              </td>
              <td className="px-4 py-2 text-success-color">Completed</td>
            </tr>
            <tr className="border-b border-border-color">
              <td className="px-4 py-2 text-secondary-text">26/09/25</td>
              <td className="px-4 py-2 text-secondary-text">
                Updated Action Plan
              </td>
              <td className="px-4 py-2 text-warning-color">In Progress</td>
            </tr>
            <tr className="border-b border-border-color">
              <td className="px-4 py-2 text-secondary-text">04/07/25</td>
              <td className="px-4 py-2 text-secondary-text">
                Closed Non-Conformance
              </td>
              <td className="px-4 py-2 text-success-color">Completed</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default DashboardTable;
