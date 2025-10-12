import { useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useParams } from "react-router-dom";
import { useForm, Controller, useWatch } from "react-hook-form";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { BookingFormSchema } from "../validationSchema";
import Breadcrumb from "./Breadcrumb";
import CTAButton from "./CTAButton";
import RHFComboBox from "./ui/RHFComboBox";
import TextInput from "./ui/TextInput";
import RHFTextArea from "./ui/RHFTextArea";
import RHFUserComboBox from "./ui/RHFUserComboBox";
import RHFStatusComboBox from "./ui/RHFStatusComboBox";
import RHFDatePickerPopout from "./ui/RHFDatePickerPopout";
import LoadingSpinner from "./LoadingSpinner";
import {
  HiOutlineWrenchScrewdriver,
  HiOutlineClipboardDocumentList,
  HiOutlineUserCircle,
} from "react-icons/hi2";
import { LuCircleDashed } from "react-icons/lu";
import { CiShoppingTag, CiTextAlignCenter } from "react-icons/ci";
import { GiFamilyHouse } from "react-icons/gi";
import { BsBox, BsQrCode, BsCurrencyPound, BsHouse } from "react-icons/bs";
import { AiOutlineTag, AiOutlineTags } from "react-icons/ai";
import { PiStack } from "react-icons/pi";
import { IoIosUndo } from "react-icons/io";
import { TfiSave } from "react-icons/tfi";
import { IoFileTrayFullOutline } from "react-icons/io5";
import { MdOutlinePrecisionManufacturing } from "react-icons/md";
import { IoPeopleOutline } from "react-icons/io5";
import {
  fetchById,
  updateRow,
  insertRow,
  getNextNCId,
} from "../api/supabaseApi";
import { useToast } from "../contexts/ToastProvider";
import SideMenuItem from "./SideMenuItem";
import UserAvatarGroup from "./ui/UserAvatarGroup";
import BadgeGroup from "./BadgeGroup";
import FileDrop from "./ui/FileDrop";
import { useUser } from "../contexts/UserProvider";
import StatusPill from "./StatusPill";
import CostData from "./CostData";
import {
  useStatusOptions,
  useEmployeesOptions,
  useFailureModeOptions,
  useSubFailureModeOptions,
  useProcessOptions,
  useCustomerOptions,
} from "@/hooks/useCategoryOptions";
import { useCreateNotification } from "@/hooks/useCreateNotification";

const BookingEntryForm = () => {
  const { slug } = useParams(); // slug = "Edit-NC-123"
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { profile } = useUser();
  const { createNotification } = useCreateNotification();

  const isEditing = slug?.startsWith("Edit-NC-");
  const isCreating = !slug;
  const id = isEditing ? slug.replace("Edit-NC-", "") : null;

  const {
    data: customerOptions,
    error: customerError,
    isLoading: isCustomerLoading,
  } = useCustomerOptions();
  const {
    data: failureModeOptions,
    error: failureModeError,
    isLoading: isFailureModeLoading,
  } = useFailureModeOptions();
  const {
    data: subFailureModeOptions,
    error: subFailureModeError,
    isLoading: isSubFailureModeLoading,
  } = useSubFailureModeOptions();
  const {
    data: processOptions,
    error: processError,
    isLoading: isProcessLoading,
  } = useProcessOptions();
  const {
    data: statusOptions,
    error: statusError,
    isLoading: isStatusLoading,
  } = useStatusOptions();
  const {
    data: employeeOptions,
    employeeError,
    isLoading: isEmployeeLoading,
  } = useEmployeesOptions();

  const { data, error, isLoading } = useQuery({
    queryKey: ["NCM", id],
    queryFn: async () => {
      if (!id) throw new Error("Missing ID");
      const result = await fetchById("NCM", id);
      if (!result) throw new Error("Record not found"); // ✅ force query error if no result
      return result;
    },
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  useEffect(() => {
    if (isEditing && error) {
      showToast({
        type: "error",
        title: "Not Found",
        message:
          "The non-conformance record you're trying to access does not exist.",
      });
      navigate("/Non-Conformance/Internal");
    }
  }, [error, isEditing, navigate, showToast]);

  const defaultValues = useMemo(
    () => ({
      ncm_id: "New NCM",
      date: undefined,
      customer: undefined,
      failure_mode: undefined,
      sub_failure_mode: undefined,
      causal_process: undefined,
      location_detected: undefined,
      responsible_operator: undefined,
      status: statusOptions
        ? statusOptions.find((s) => s.type === "initial")?.id
        : undefined,
      description: "",
      work_order: "",
      workOrder2: "",
      part_number: "",
      quantity_checked: undefined,
      quantity_defective: undefined,
    }),
    [statusOptions]
  );

  const {
    control,
    handleSubmit,
    reset,
    setValue,
    trigger,
    watch,
    formState: { errors, isSubmitting, isValid, isDirty, touchedFields },
  } = useForm({
    resolver: zodResolver(BookingFormSchema),
    mode: "all",
    defaultValues: defaultValues,
    delayError: 500,
  });

  useEffect(() => {
    if (data) {
      const parsedData = {
        ...defaultValues,
        ...data,
        date: data.date ? new Date(data.date) : null,
      };
      reset(parsedData);
    } else if (isCreating) {
      reset(defaultValues);
    }
  }, [data, isCreating, isEditing, reset, setValue, showToast]);

  const scrollContainerRef = useRef(null);
  const ncDetailsRef = useRef(null);
  const costRef = useRef(null);
  const investigationRef = useRef(null);
  const summaryRef = useRef(null);
  const queryClient = useQueryClient();

  const failureMode = useWatch({
    control,
    name: "failure_mode",
  });

  const previousFailureMode = useRef(failureMode);
  const isResetting = useRef(false);

  useEffect(() => {
    if (isResetting.current) {
      // Skip resetting sub_failure_mode while resetting
      isResetting.current = false;
      previousFailureMode.current = failureMode;
      return;
    }

    if (
      previousFailureMode.current !== failureMode &&
      previousFailureMode.current !== undefined
    ) {
      setValue("sub_failure_mode", null);
    }

    previousFailureMode.current = failureMode;
  }, [failureMode, setValue]);

  const handleCreate = useMutation({
    mutationFn: ({ table, row }) => insertRow(table, row),
    onSuccess: (result) => {
      showToast({
        type: "success",
        title: "Success",
        message: `New record has been created - ${result.ncm_id}`,
      });
      queryClient.invalidateQueries(["NCM"]);
      navigate(`/Non-Conformance/Internal/Edit-NC-${result.id}`);
      createNotification({
        title: "New NC created",
        body: "created a new non-conformance record:",
        metaData: {
          url: `/Non-Conformance/Internal/Edit-NC-${result.id}`,
          buttonText: "View",
        },
        docRef: result.ncm_id,
      });
    },
    onError: (error) => {
      showToast({ type: "error", title: "Error", message: error.message });
    },
  });

  const handleUpdate = useMutation({
    mutationFn: ({ table, id, updates }) => updateRow(table, id, updates),
    onSuccess: (result) => {
      showToast({
        type: "success",
        title: "Success",
        message: `Changes to ${result.ncm_id} have been saved`,
      });
      queryClient.invalidateQueries(["NCM", result.id]);
    },
    onError: (error) => {
      showToast({ type: "error", title: "Error", message: error.message });
    },
  });

  const handleSubmitForm = async (formData, id) => {
    try {
      if (isCreating) {
        const nextId = await getNextNCId("NCM", "ncm_id");
        const newFormData = {
          ...formData,
          ncm_id: nextId,
          logged_by: profile.id,
        };
        await handleCreate.mutateAsync({ table: "NCM", row: newFormData });
      } else if (isEditing) {
        await handleUpdate.mutateAsync({
          table: "NCM",
          id: id,
          updates: formData,
        });
      }
    } catch (error) {
      showToast({
        type: "error",
        title: "Error",
        message: `Failed to save changes: ${error.message}`,
      });
    }
  };

  const handleScrollTo = (scrollContainerRef, sectionRef) => {
    if (!scrollContainerRef.current || !sectionRef.current) return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const loggedByUser =
    data && employeeOptions
      ? employeeOptions.find((u) => u.id === data.logged_by)
      : null;

  const status = (() => {
    if (isEditing && data && statusOptions) {
      // Editing mode: show status from loaded record
      return statusOptions.find((s) => s.id === watch("status"));
    }

    if (isCreating && statusOptions) {
      // Creating mode: show watched form status, or fallback
      const fallbackStatusId = watch("status") ?? 6;
      return statusOptions.find((s) => s.id === fallbackStatusId);
    }

    // Fallback if statusOptions not loaded yet
    return null;
  })();

  const formattedDate = (dateInput) =>
    new Date(dateInput).toLocaleString("en-GB", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

  if (isLoading || isStatusLoading || !statusOptions) {
    return (
      <div className="flex items-center justify-center h-screen bg-primary-bg">
        <LoadingSpinner />
      </div>
    );
  }
  return (
    <div className="flex flex-col grow h-screen overflow-hidden bg-primary-bg">
      <div className="flex flex-row items-center justify-between px-5 py-2 bg-primary-bg border-b border-border-color">
        <div className="flex flex-row gap-3 py-2 items-center">
          <Breadcrumb />
        </div>
        <div className="flex flex-row gap-3 items-center">
          {isDirty && (
            <CTAButton
              type="cancel"
              icon={IoIosUndo}
              text="Revert"
              callbackFn={() => {
                isResetting.current = true;
                reset();
              }}
            />
          )}
          {isDirty && (
            <CTAButton
              type="success"
              icon={TfiSave}
              iconSize="h-4.5 w-4.5"
              text={isCreating ? "Create" : "Save"}
              callbackFn={handleSubmit(
                async (formData) => {
                  if (!isValid) {
                    showToast({
                      type: "info",
                      title: "Validation Incomplete",
                      message: "Please correct form errors before saving.",
                    });
                    return;
                  }
                  const recordId = isCreating ? null : data.id;
                  await handleSubmitForm(formData, recordId);
                },
                (errors) => {
                  showToast({
                    type: "info",
                    title: "Validation Incomplete",
                    message: `Please correct the following errors: ${Object.values(
                      errors
                    )
                      .map((error) => error.message)
                      .join(", ")}`,
                  });
                }
              )}
              disabled={
                isSubmitting || handleCreate.isLoading || handleUpdate.isLoading
              }
            />
          )}
        </div>
      </div>
      <form
        onSubmit={(e) => e.preventDefault()}
        className="flex flex-1 overflow-hidden">
        <div className="flex flex-row w-full bg-primary-bg h-full overflow-hidden">
          <div className="flex justify-start w-70 border-r border-border-color flex-col px-3 h-full bg-primary-bg">
            <div className="border-b items-center flex-col border-border-dark-color text-primary-text text-lg pt-4 mb-2 pb-3">
              <StatusPill status={status?.id} />
            </div>
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
                title: "Additional Info",
                subtitle: "More NC details",
                icon: IoFileTrayFullOutline,
                ref: summaryRef,
              },
            ].map((item, i, arr) => (
              <button
                key={i}
                onClick={() => handleScrollTo(scrollContainerRef, item.ref)}>
                <SideMenuItem
                  isCreating={isCreating}
                  title={item.title}
                  subtitle={item.subtitle}
                  icon={item.icon}
                  index={i}
                  arrLength={arr.length}
                />
              </button>
            ))}
          </div>
          <div
            ref={scrollContainerRef}
            className="flex p-5 gap-5 flex-col grow bg-primary-bg h-full overflow-y-auto">
            <div
              ref={ncDetailsRef}
              className="flex scroll-mt-5 flex-row justify-start items-center gap-3 px-2">
              <h2 className="text-2xl text-primary-text whitespace-nowrap">
                Booking Details
              </h2>
              <div className="h-0.5 w-full bg-border-color"></div>
            </div>
            <div className="flex flex-col justify-between items-center bg-secondary-bg rounded-2xl p-6 shadow-lg shadow-shadow-color">
              <div className="grid items-start grid-cols-1 md:grid-cols-1 lg:grid-cols-2 w-full gap-y-4 gap-x-8">
                <Controller
                  name="date"
                  control={control}
                  render={({ field, fieldState }) => (
                    <RHFDatePickerPopout
                      label="Date of Booking"
                      placeholder="Pick a date"
                      error={fieldState.error}
                      value={field.value ? new Date(field.value) : null}
                      onChange={field.onChange}
                    />
                  )}
                />

                <Controller
                  name="customer"
                  control={control}
                  render={({ field, fieldState }) => (
                    <RHFComboBox
                      {...field}
                      error={fieldState.error}
                      placeholder="Search for a property"
                      secondaryField={"customer_id"}
                      options={customerOptions || []}
                      icon={GiFamilyHouse}
                      label="Property"
                    />
                  )}
                />
                <Controller
                  name="work_order"
                  control={control}
                  render={({ field, fieldState }) => (
                    <TextInput
                      {...field}
                      value={field.value ?? ""}
                      error={fieldState.error}
                      label="Work Order No."
                      icon={BsBox}
                      placeholder="Enter Work Order No."
                      type="text"
                    />
                  )}
                />
                <Controller
                  name="part_number"
                  control={control}
                  render={({ field, fieldState }) => (
                    <TextInput
                      {...field}
                      value={field.value ?? ""}
                      error={fieldState.error}
                      label="Part No."
                      icon={BsQrCode}
                      placeholder="Enter Part No."
                      type="text"
                    />
                  )}
                />
                <Controller
                  name="workOrder2"
                  control={control}
                  render={({ field, fieldState }) => (
                    <TextInput
                      {...field}
                      value={field.value ?? ""}
                      error={fieldState.error}
                      label="Work Order No2."
                      icon={BsQrCode}
                      placeholder="Enter Work Order No."
                      type="text"
                    />
                  )}
                />
                <div className="w-full flex justify-between items-center gap-5">
                  <Controller
                    name="quantity_checked"
                    control={control}
                    render={({ field, fieldState }) => (
                      <TextInput
                        {...field}
                        error={fieldState.error}
                        label="Checked Quantity"
                        icon={PiStack}
                        placeholder="Enter Qty"
                        dataType="number"
                        onChange={(e) => {
                          const val = e.target.value;
                          field.onChange(
                            val === "" ? undefined : parseFloat(val)
                          );
                          trigger("quantity_defective");
                        }}
                        value={field.value ?? ""}
                      />
                    )}
                  />
                  <Controller
                    name="quantity_defective"
                    control={control}
                    render={({ field, fieldState }) => (
                      <TextInput
                        {...field}
                        error={fieldState.error}
                        label="Defective Quantity"
                        icon={PiStack}
                        placeholder="Enter Qty"
                        dataType="number"
                        onChange={(e) => {
                          const val = e.target.value;
                          field.onChange(
                            val === "" ? undefined : parseFloat(val)
                          );
                          trigger("quantity_checked");
                        }}
                        value={field.value ?? ""}
                      />
                    )}
                  />
                </div>
                <div className="row-span-2">
                  <Controller
                    name="description"
                    control={control}
                    render={({ field, fieldState }) => (
                      <RHFTextArea
                        {...field}
                        value={field.value ?? ""}
                        error={fieldState.error}
                        placeholder="Enter a description of the NC"
                        label="Description"
                        icon={CiTextAlignCenter}
                      />
                    )}
                  />
                </div>
                <Controller
                  name="failure_mode"
                  control={control}
                  render={({ field, fieldState }) => (
                    <RHFComboBox
                      {...field}
                      error={fieldState.error}
                      placeholder="Select a failure mode"
                      secondaryField={"code"}
                      options={failureModeOptions || []}
                      icon={AiOutlineTag}
                      label="Failure Mode"
                      onSearchTermChange={() => {}}
                    />
                  )}
                />
                <Controller
                  name="sub_failure_mode"
                  control={control}
                  render={({ field, fieldState }) => (
                    <RHFComboBox
                      {...field}
                      error={fieldState.error}
                      placeholder="Select a sub-failure mode"
                      options={subFailureModeOptions || []}
                      icon={AiOutlineTags}
                      label="Sub-Failure Mode"
                      onSearchTermChange={() => {}}
                      dependentKey={"failure_mode"}
                      dependentValue={watch("failure_mode") || null}
                      secondaryField={"code"}
                      secondaryFieldOptions={failureModeOptions || []}
                    />
                  )}
                />
                <Controller
                  name="causal_process"
                  control={control}
                  render={({ field, fieldState }) => (
                    <RHFComboBox
                      {...field}
                      error={fieldState.error}
                      placeholder="Select a process"
                      secondaryField={"code"}
                      options={processOptions || []}
                      icon={MdOutlinePrecisionManufacturing}
                      label="Causal Process"
                      onSearchTermChange={() => {}}
                    />
                  )}
                />
                <Controller
                  name="location_detected"
                  control={control}
                  render={({ field, fieldState }) => (
                    <RHFComboBox
                      {...field}
                      error={fieldState.error}
                      placeholder="Select a location"
                      secondaryField={"code"}
                      options={processOptions || []}
                      icon={MdOutlinePrecisionManufacturing}
                      label="Detection Location"
                      onSearchTermChange={() => {}}
                    />
                  )}
                />
                <Controller
                  name="responsible_operator"
                  control={control}
                  render={({ field, fieldState }) => (
                    <RHFUserComboBox
                      {...field}
                      error={fieldState.error}
                      placeholder="Select an operator"
                      users={employeeOptions || []}
                      label="Responsible Operator"
                    />
                  )}
                />
                <Controller
                  name="status"
                  control={control}
                  render={({ field, fieldState }) => (
                    <RHFStatusComboBox
                      error={fieldState.error}
                      placeholder="Select an status"
                      options={statusOptions || []}
                      label="Status"
                      icon={LuCircleDashed}
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </div>
            </div>
            {!isCreating && (
              <div className="flex flex-col gap-5">
                <div
                  ref={costRef}
                  className="flex scroll-mt-5 flex-row justify-start items-center gap-3 px-2">
                  <h2 className="text-2xl text-primary-text whitespace-nowrap">
                    Cost
                  </h2>
                  <div className="h-0.5 w-full bg-border-color"></div>
                </div>
                <div className="flex flex-col justify-between items-center bg-secondary-bg rounded-2xl p-6 shadow-lg shadow-shadow-color">
                  <CostData ncRef={data?.ncm_id} />
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
                  {!data?.ref_8D ? (
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
                    <div className="flex flex-row justify-between items-center w-full">
                      <div className="flex flex-col justify-between items-start gap-2">
                        <UserAvatarGroup users={employeeOptions} />
                      </div>
                      <BadgeGroup stage={parsedData.ref_8D} />
                    </div>
                  )}
                </div>
                <div
                  ref={summaryRef}
                  className="flex scroll-mt-5 flex-row justify-start items-center gap-3 px-2">
                  <h2 className="text-2xl text-primary-text whitespace-nowrap">
                    Additional Information
                  </h2>
                  <div className="h-0.5 w-full bg-border-color"></div>
                </div>
                <div className="flex flex-col justify-between items-center bg-secondary-bg rounded-2xl p-6 shadow-lg shadow-shadow-color">
                  <FileDrop ncm_id={data?.ncm_id} />
                  <br />
                  <br />
                  <br />
                  <div className="flex text-primary-text pl-1 text-md italic">{`${
                    data?.ncm_id
                  } created by ${loggedByUser?.first_name ?? "Unknown"} ${
                    loggedByUser?.surname ?? ""
                  } on ${formattedDate(data?.created_at)}`}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
};

export default BookingEntryForm;
