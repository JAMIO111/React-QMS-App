import { forwardRef, useImperativeHandle } from "react";
import { useQuery } from "@tanstack/react-query";
import supabase from "../supabase-client";
import CTAButton from "./CTAButton";
import { useModal } from "../contexts/ModalContext";
import CostInputForm from "./CostInputForm";
import { CiViewTable } from "react-icons/ci";
import { IoAddOutline } from "react-icons/io5";
import { convertCurrency } from "../api/uniRateExchangeApi";

const CostData = ({ ncRef }) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ["Costs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("Costs")
        .select("*")
        .eq("nc_ref", ncRef)
        .order("created_at", { ascending: false });

      if (error) {
        throw new Error(error.message);
      }
      return data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const { openModal, closeModal } = useModal();

  return (
    <div className="flex flex-col items-start justify-center h-full w-full gap-4">
      <div className="flex w-full justify-between items-center px-1">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-2xl text-primary-text font-semibold">
            Cost Data
          </h2>
          <p className="text-secondary-text text-sm">
            Add expenses to your non-conformance here.
          </p>
        </div>
        <div className="flex h-full items-end gap-4">
          <CTAButton
            type="main"
            title="New Cost Item"
            text="New Item"
            icon={IoAddOutline}
            callbackFn={() =>
              openModal({
                title: "New Cost Item",
                content: <CostInputForm recordId={ncRef} />,
              })
            }
          />
          <CTAButton
            type="neutral"
            title="More Info"
            icon={CiViewTable}
            text="More Info"
            callbackFn={() =>
              openModal({
                title: "Expanded Cost Data View",
                content: <CostInputForm recordId={ncRef} />,
              })
            }
          />
        </div>
      </div>
      <div className="w-full h-full bg-secondary-bg border border-border-color rounded-xl overflow-clip">
        <table className="w-full table-auto text-sm">
          <thead className="bg-primary-bg text-primary-text">
            <tr className="border-b border-border-color">
              <th className="px-4 py-2 text-left">Date Logged</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-left">Cost Type</th>
              <th className="px-4 py-2 text-right">Amount (GBP)</th>
              <th className="px-4 py-2 text-right">Amount (USD)</th>
            </tr>
          </thead>
          <tbody className="text-secondary-text">
            {data?.length > 0 ? (
              data.map((cost, index) => (
                <tr
                  key={index}
                  className="hover:bg-border-color/10 transition-colors duration-200">
                  <td className="border-t-1 px-4 py-2 text-left">
                    {cost.description || "No description provided"}
                  </td>
                  <td className="border-t-1 px-4 py-2 text-left">
                    {cost.cost_type_name || "Unknown"}
                  </td>
                  <td className="border-t-1 px-4 py-2 text-right">£500.00</td>
                  <td className="border-t-1 px-4 py-2 text-right">$462.30</td>
                  <td className="border-t-1 px-4 py-2 text-center">
                    {new Date(cost.created_at).toLocaleDateString("en-GB", {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                    })}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="text-center py-4 text-muted">
                  No cost items logged yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CostData;
