import { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Breadcrumb from "./Breadcrumb";
import CTAButton from "./CTAButton";
import ComboBox from "./ui/ComboBox";
import TextInput from "./ui/TextInput";
import TextArea from "./ui/TextArea";
import UserComboBox from "./ui/UserComboBox";
import StatusComboBox from "./ui/StatusComboBox";
import DatePickerPopout from "./ui/DatePickerPopout";
import {
  HiOutlineWrenchScrewdriver,
  HiOutlineClipboardDocumentList,
  HiOutlineUserCircle,
} from "react-icons/hi2";
import { LuCircleDashed } from "react-icons/lu";
import { CiShoppingTag, CiTextAlignCenter } from "react-icons/ci";
import { TbTag } from "react-icons/tb";
import { BsBox, BsQrCode, BsCurrencyPound } from "react-icons/bs";
import { AiOutlineTag, AiOutlineTags } from "react-icons/ai";
import { PiStack } from "react-icons/pi";
import { IoIosUndo } from "react-icons/io";
import { RiSave3Fill } from "react-icons/ri";
import { MdOutlinePrecisionManufacturing } from "react-icons/md";
import { IoPeopleOutline } from "react-icons/io5";
import { fetchAll, fetchById, updateRow } from "../api/supabaseApi";
import { useToast } from "../contexts/ToastProvider";
import SideMenuItem from "./SideMenuItem";
import Skeleton from "./Skeleton";
import UserAvatarGroup from "./ui/UserAvatarGroup";

const NCEntryForm = () => {
  const { showToast } = useToast();
  const [formData, setFormData] = useState(null);
  const [new8D, setNew8D] = useState(false);
  const { slug } = useParams(); // slug = "Edit-NC-123"
  const isEditing = slug?.startsWith("Edit-NC-");
  const id = isEditing ? slug.replace("Edit-NC-", "") : null;
  const isCreating = slug === "New-NC";

  const scrollContainerRef = useRef(null);
  const ncDetailsRef = useRef(null);
  const costRef = useRef(null);
  const investigationRef = useRef(null);
  const summaryRef = useRef(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ["NCM", id],
    queryFn: async () => {
      try {
        const result = await fetchById("NCM", id);
        console.log("Query fetched:", result);
        return result;
      } catch (e) {
        console.error("fetchById failed:", e);
        throw e;
      }
    },
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (updates) => updateRow("NCM", id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries(["NCM", id]);
      showToast({
        type: "success",
        title: "Saved",
        message: "Changes have been successfully saved.",
      });
    },
    onError: (error) => {
      console.error("Error saving data:", error);
      showToast({
        type: "error",
        title: "Save Failed",
        message: "Something went wrong while saving the changes.",
      });
    },
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
  const handleSelectStatus = (selectedStatus) => {
    setFormData({
      ...formData,
      status: selectedStatus?.id || null,
    });
  };

  const handleScrollTo = (scrollContainerRef, sectionRef) => {
    if (!scrollContainerRef.current || !sectionRef.current) return;

    sectionRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const isDirty = JSON.stringify(formData) !== JSON.stringify(data);

  return (
    <div className="flex flex-col flex-1 overflow-auto bg-primary-bg">
      <div className="flex flex-row items-center justify-between px-5 py-2 bg-primary-bg border-b border-border-color">
        <div className="flex flex-row gap-3 items-center">
          <Breadcrumb />
        </div>
        <div className="flex flex-row gap-3 items-center">
          <CTAButton
            type="main"
            icon={CiShoppingTag}
            text="New NC"
            callbackFn={() => {
              setNew8D(!new8D);
            }}
          />
          {isDirty && (
            <CTAButton type="cancel" icon={IoIosUndo} text="Revert" />
          )}
          <CTAButton
            type="main"
            icon={RiSave3Fill}
            text="Save"
            callbackFn={() => mutation.mutate(formData)}
          />
        </div>
      </div>
      <div className="flex flex-row flex-grow w-full bg-primary-bg overflow-hidden">
        <div className="flex justify-start w-90 border-r border-border-color flex-col px-5 h-full bg-primary-bg">
          <span className="border-b border-border-dark-color text-left text-primary-text text-2xl pt-5 pl-8 mb-2 pb-2">
            {formData?.ncm_id ? formData.ncm_id : "New Record"}
          </span>
          {[
            {
              title: "NC Details",
              subtitle: "Log NC Information",
              icon: HiOutlineClipboardDocumentList,
              ref: ncDetailsRef,
            },
            {
              title: "Cost",
              subtitle: "Track NC Expenses",
              icon: BsCurrencyPound,
              ref: costRef,
            },
            {
              title: "Investigation",
              subtitle: "Complete RCA and 8D",
              icon: HiOutlineWrenchScrewdriver,
              ref: investigationRef,
            },
            {
              title: "Summary",
              subtitle: "Review Status of NC",
              icon: TbTag,
              ref: summaryRef,
            },
          ].map((item, i, arr) => (
            <a
              key={i}
              onClick={() => handleScrollTo(scrollContainerRef, item.ref, 20)}>
              <SideMenuItem
                title={item.title}
                subtitle={item.subtitle}
                icon={item.icon}
                index={i}
                arrLength={arr.length}
              />
            </a>
          ))}
        </div>
        <div
          ref={scrollContainerRef}
          className="flex p-5 gap-5 flex-col flex-grow bg-primary-bg overflow-y-auto">
          <div
            ref={ncDetailsRef}
            className="flex scroll-mt-5 flex-row justify-start items-center gap-3 px-2">
            <h2 className="text-2xl text-primary-text whitespace-nowrap">
              NC Details
            </h2>
            <div className="h-0.5 w-full bg-border-color"></div>
          </div>
          <div className="flex flex-col justify-between items-center bg-secondary-bg rounded-2xl p-6 shadow-lg shadow-shadow-color">
            <div className="grid items-start grid-cols-1 md:grid-cols-1 lg:grid-cols-2 w-full gap-y-4 gap-x-8">
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
                  onSearchTermChange={() => {}}
                  selected={customerOptions?.find(
                    (opt) => opt.id === formData?.customer
                  )}
                />
              )}
              <TextInput
                label="Work Order No."
                icon={BsBox}
                placeholder="Enter Work Order No."
                value={formData?.work_order || ""}
                type="text"
                name="workOrder"
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    work_order: e.target.value,
                  }))
                }
              />
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
                  label="Work Order No."
                  icon={BsQrCode}
                  placeholder="Enter Work Order No.."
                  value={formData?.work_order || ""}
                  type="text"
                  name="workOrder"
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      work_order: e.target.value,
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
              {isStatusLoading ? (
                <Skeleton />
              ) : (
                <StatusComboBox
                  placeholder="Select an status"
                  options={statusOptions || []}
                  label="Status"
                  icon={LuCircleDashed}
                  setSelected={handleSelectStatus}
                  selected={statusOptions?.find(
                    (opt) => opt.id === formData?.status
                  )}
                />
              )}
            </div>
          </div>
          <div
            ref={costRef}
            className="flex scroll-mt-5 flex-row justify-start items-center gap-3 px-2">
            <h2 className="text-2xl text-primary-text whitespace-nowrap">
              Cost
            </h2>
            <div className="h-0.5 w-full bg-border-color"></div>
          </div>
          <div className="flex flex-col justify-between items-center bg-secondary-bg rounded-2xl p-6 shadow-lg shadow-shadow-color">
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
          </div>
          <div
            ref={investigationRef}
            className="flex scroll-mt-5 flex-row justify-start items-center gap-3 px-2">
            <h2 className="text-2xl text-primary-text whitespace-nowrap">
              8D Investigation
            </h2>
            <div className="h-0.5 w-full bg-border-color"></div>
          </div>
          <div className="flex flex-row justify-between items-center bg-secondary-bg rounded-2xl p-6 shadow-lg shadow-shadow-color">
            {new8D ? (
              <div className="flex flex-row justify-around items-center w-full h-50">
                <CTAButton
                  text="Start a new 8D Investigation"
                  type="main"
                  icon={HiOutlineUserCircle}
                  height="h-16"
                  width="w-80"
                />
                <CTAButton
                  text="Assign NC to an existing 8D"
                  type="main"
                  icon={HiOutlineUserCircle}
                  height="h-16"
                  width="w-80"
                />
              </div>
            ) : (
              <div className="flex flex-col justify-between items-start gap-2">
                <p>8D Team</p>
                <UserAvatarGroup users={employeeOptions} />
              </div>
            )}
          </div>
          <div
            ref={summaryRef}
            className="flex scroll-mt-5 flex-row justify-start items-center gap-3 px-2">
            <h2 className="text-2xl text-primary-text whitespace-nowrap">
              Summary
            </h2>
            <div className="h-0.5 w-full bg-border-color"></div>
          </div>
          <div className="flex flex-col justify-between items-center bg-secondary-bg rounded-2xl p-6 shadow-lg shadow-shadow-color">
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
            <br />
          </div>
        </div>
      </div>
    </div>
  );
};

export default NCEntryForm;
