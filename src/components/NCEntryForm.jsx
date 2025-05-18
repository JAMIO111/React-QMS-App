import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Breadcrumb from "./Breadcrumb";
import CTAButton from "./CTAButton";
import ComboBox from "./ui/ComboBox";
import TextInput from "./ui/TextInput";
import TextArea from "./ui/TextArea";
import UserComboBox from "./ui/UserComboBox";
import { HiOutlineUserCircle } from "react-icons/hi2";
import { CiShoppingTag, CiTextAlignCenter } from "react-icons/ci";
import { TbTag } from "react-icons/tb";
import { BsBox, BsQrCode } from "react-icons/bs";
import { AiOutlineTag, AiOutlineTags } from "react-icons/ai";
import { BsCurrencyPound } from "react-icons/bs";
import { PiStack } from "react-icons/pi";
import { IoIosUndo } from "react-icons/io";
import { RiSave3Fill } from "react-icons/ri";
import { MdOutlinePrecisionManufacturing } from "react-icons/md";
import { HiOutlineWrenchScrewdriver } from "react-icons/hi2";
import { HiOutlineClipboardDocumentList } from "react-icons/hi2";
import DatePickerPopout from "./ui/DatePickerPopout";
import { IoPeopleOutline } from "react-icons/io5";
import { fetchAll, fetchById } from "../api/supabaseApi";
import SideMenuItem from "./SideMenuItem";
import Skeleton from "./Skeleton";

const NCEntryForm = () => {
  const location = useLocation();
  const [formData, setFormData] = useState(null);
  const passedItem = location.state.itemID || null;
  const [step, setStep] = useState(1);

  const { data, error, isLoading } = useQuery({
    queryKey: ["NCM", passedItem],
    queryFn: async () => {
      try {
        const result = await fetchById("NCM", passedItem);
        console.log("Query fetched:", result);
        return result;
      } catch (e) {
        console.error("fetchById failed:", e);
        throw e;
      }
    },
    enabled: !!passedItem,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
  const {
    data: customerOptions,
    error: customerError,
    isLoading: isCustomerLoading,
  } = useQuery({
    queryKey: ["Customers"],
    queryFn: () => fetchAll("Customers"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
  const {
    data: failureModeOptions,
    error: failureModeError,
    isLoading: isFailureModeLoading,
  } = useQuery({
    queryKey: ["Failure Mode"],
    queryFn: () => fetchAll("Failure Mode"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
  const {
    data: subFailureModeOptions,
    error: subFailureModeError,
    isLoading: isSubFailureModeLoading,
  } = useQuery({
    queryKey: ["Sub-Failure Mode"],
    queryFn: () => fetchAll("Sub-Failure Mode"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
  const {
    data: processOptions,
    error: processError,
    isLoading: isProcessLoading,
  } = useQuery({
    queryKey: ["Process"],
    queryFn: () => fetchAll("Process"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
  const {
    data: statusOptions,
    error: statusError,
    isLoading: isStatusLoading,
  } = useQuery({
    queryKey: ["Status"],
    queryFn: () => fetchAll("Status"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
  const {
    data: employeeOptions,
    employeeError,
    isLoading: isEmployeeLoading,
  } = useQuery({
    queryKey: ["Employees"],
    queryFn: () => fetchAll("Employees"),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });

  useEffect(() => {
    if (data) {
      setFormData(data);
    }
  }, [data]);

  const handleSelectCustomer = (selectedCustomer) => {
    setFormData({
      ...formData,
      customer: selectedCustomer?.id || null,
    });
  };
  const handleSelectFailureMode = (selectedFailureMode) => {
    setFormData({
      ...formData,
      failure_mode: selectedFailureMode?.id || null,
      sub_failure_mode: null,
    });
  };
  const handleSelectSubFailureMode = (selectedSubFailureMode) => {
    setFormData({
      ...formData,
      sub_failure_mode: selectedSubFailureMode?.id || null,
    });
  };
  const handleSelectProcess = (selectedProcess) => {
    setFormData({
      ...formData,
      causal_process: selectedProcess?.id || null,
    });
  };
  const handleSelectResponsibleOperator = (selectedResponsibleOperator) => {
    setFormData({
      ...formData,
      responsible_operator: selectedResponsibleOperator?.id || null,
    });
  };

  return (
    <div className="flex flex-col h-screen bg-primary-bg">
      <div className="flex flex-row items-center justify-between p-5 bg-primary-bg border-b border-border-color">
        <div className="flex flex-row gap-3 items-center">
          <Breadcrumb />
        </div>
        <div className="flex flex-row gap-3 items-center">
          <CTAButton type="cancel" icon={IoIosUndo} text="Revert" />
          <CTAButton type="main" icon={RiSave3Fill} text="Save" />
        </div>
      </div>
      <div className="flex flex-row flex-grow w-full bg-primary-bg overflow-hidden">
        <div className="flex justify-start w-85 border-r border-border-color flex-col px-3 h-full bg-primary-bg">
          <span className="border-b border-border-dark-color text-right text-primary-text text-2xl font-semibold pt-2 pr-2">
            {formData?.ncm_id ? formData.ncm_id : "New NC"}
          </span>
          {[
            {
              title: "NC Details",
              subtitle: "Log NC Information",
              icon: HiOutlineClipboardDocumentList,
            },
            {
              title: "Cost",
              subtitle: "Track NC Expenses",
              icon: BsCurrencyPound,
            },
            {
              title: "Investigation",
              subtitle: "Complete RCA and 8D",
              icon: HiOutlineWrenchScrewdriver,
            },
            { title: "Summary", subtitle: "Review Status of NC", icon: TbTag },
          ].map((item, i, arr) => (
            <div key={i}>
              <div
                className={`${
                  i === 0 ? "bg-transparent" : "bg-brand-primary/70"
                } relative left-[85.5%] w-0.5 h-8`}></div>
              <SideMenuItem
                title={item.title}
                subtitle={item.subtitle}
                icon={item.icon}
                index={i}
                arrLength={arr.length}
              />
            </div>
          ))}
        </div>
        <div className="grid items-start p-5 grid-cols-1 md:grid-cols-1 lg:grid-cols-2 w-full gap-8 bg-secondary-bg overflow-y-auto pb-30">
          <DatePickerPopout
            label="Date of NC"
            placeholder="Pick a date"
            currentDate={formData?.date ? new Date(formData.date) : null}
            onChange={(date) =>
              setFormData((prev) => ({
                ...prev,
                date: date.toLocaleDateString("en-GB", {
                  weekday: "long", // Fri
                  day: "numeric", // 08
                  month: "long", // Sep
                  year: "numeric", // 25
                }),
              }))
            }
          />
          <TextInput
            label="Claim Ref."
            icon={BsBox}
            placeholder="Enter Claim Ref."
            value={formData?.claim_ref || ""}
            type="text"
            name="claimRef"
            onChange={(e) =>
              setFormData((prev) => ({
                ...prev,
                claim_ref: e.target.value,
              }))
            }
          />
          {isCustomerLoading ? (
            <Skeleton />
          ) : (
            <ComboBox
              placeholder="Search for a customer"
              secondaryField={"customer_id"}
              options={customerOptions || []}
              icon={IoPeopleOutline}
              label="Customer"
              setSelected={handleSelectCustomer}
              //searchTerm=""
              onSearchTermChange={() => {}}
              selected={customerOptions?.find(
                (opt) => opt.id === formData?.customer
              )}
            />
          )}
          {isLoading ? (
            <Skeleton />
          ) : (
            <TextInput
              label="Part No."
              icon={BsQrCode}
              placeholder="Enter Part No."
              value={formData?.part_number || ""}
              type="text"
              name="partNumber"
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  part_number: e.target.value,
                }))
              }
            />
          )}
          {isLoading ? (
            <Skeleton />
          ) : (
            <TextInput
              label="Defective Quantity"
              icon={PiStack}
              placeholder="Enter Qty"
              value={formData?.quantity || ""}
              type="number"
              name="qty"
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  quantity: e.target.value,
                }))
              }
            />
          )}
          <div className="row-span-2">
            <TextArea
              value={formData?.description}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  description: e.target.value,
                }))
              }
              label="Description"
              icon={CiTextAlignCenter}
            />
          </div>
          {isCustomerLoading ? (
            <Skeleton />
          ) : (
            <ComboBox
              placeholder="Select a failure mode"
              secondaryField={"code"}
              options={failureModeOptions || []}
              icon={AiOutlineTag}
              label="Failure Mode"
              setSelected={handleSelectFailureMode}
              onSearchTermChange={() => {}}
              selected={failureModeOptions?.find(
                (opt) => opt.id === formData?.failure_mode
              )}
            />
          )}
          {isSubFailureModeLoading ? (
            <Skeleton />
          ) : (
            <ComboBox
              placeholder="Select a sub-failure mode"
              options={subFailureModeOptions || []}
              icon={AiOutlineTags}
              label="Sub-Failure Mode"
              setSelected={handleSelectSubFailureMode}
              onSearchTermChange={() => {}}
              selected={subFailureModeOptions?.find(
                (opt) => opt.id === formData?.sub_failure_mode
              )}
              dependentKey={"failure_mode"}
              dependentValue={formData?.failure_mode}
            />
          )}
          {isProcessLoading ? (
            <Skeleton />
          ) : (
            <ComboBox
              placeholder="Select a process"
              secondaryField={"code"}
              options={processOptions || []}
              icon={MdOutlinePrecisionManufacturing}
              label="Causal Process"
              setSelected={handleSelectProcess}
              onSearchTermChange={() => {}}
              selected={processOptions?.find(
                (opt) => opt.id === formData?.causal_process
              )}
            />
          )}
          {isEmployeeLoading ? (
            <Skeleton />
          ) : (
            <UserComboBox
              placeholder="Select an operator"
              users={employeeOptions || []}
              label="Responsible Operator"
              setSelected={handleSelectResponsibleOperator}
              selected={employeeOptions?.find(
                (opt) => opt.id === formData?.responsible_operator
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default NCEntryForm;
