import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { IoIosMan } from "react-icons/io";
import { FaChildren, FaDog, FaBed, FaUser } from "react-icons/fa6";
import { HiPhone } from "react-icons/hi2";
import { BsHouse } from "react-icons/bs";
import { MdChildFriendly } from "react-icons/md";
import { IoReceiptOutline } from "react-icons/io5";
import { LuFence } from "react-icons/lu";
import NumericInputGroup from "./NumericInputGroup";
import TextInput from "./ui/TextInput";
import { BookingFormSchema } from "../validationSchema";
import RHFComboBox from "./ui/RHFComboBox";
import { useProperties } from "@/hooks/useProperties";
import { useBookingById } from "@/hooks/useBookingById";
import DateRangePicker from "./ui/DateRangePicker";
import CTAButton from "./CTAButton";
import { IoIosUndo } from "react-icons/io";
import { FaCheck } from "react-icons/fa";
import { TiArrowLoop } from "react-icons/ti";
import { useUpsertBooking } from "@/hooks/useUpsertBooking";
import ToggleButton from "./ui/ToggleButton";

const defaultFormData = {
  property_id: null,
  arrival_date: null,
  departure_date: null,
  nights: 0,
  lead_guest: "",
  lead_guest_contact: "",
  adults: 0,
  children: 0,
  infants: 0,
  pets: 0,
  highchairs: 0,
  cots: 0,
  stairgates: 0,
};

const BookingForm = () => {
  const { id } = useParams();
  const { data: booking } = useBookingById(id !== "New-Booking" ? id : null);
  const { data: properties } = useProperties();

  const upsertBooking = useUpsertBooking();

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    trigger,
    watch,
    formState: { errors, isSubmitting, isValid, isDirty },
  } = useForm({
    resolver: zodResolver(BookingFormSchema),
    mode: "all",
    defaultValues: defaultFormData,
    delayError: 250,
  });

  useEffect(() => {
    if (id === "New-Booking") {
      reset(defaultFormData);
    } else if (booking) {
      reset(booking);
    }
  }, [id, booking, reset]);

  console.log(watch("arrival_date"), watch("departure_date"));

  return (
    <div className="flex bg-primary-bg flex-1 flex-row p-4 gap-4">
      <div className="shadow-m rounded-2xl flex h-full gap-3 flex-1 p-5 flex-col bg-secondary-bg">
        <Controller
          name="booking_ref"
          control={control}
          render={({ field, fieldState }) => (
            <TextInput
              label="Booking Ref."
              placeholder="e.g. ABC123"
              {...field}
              icon={IoReceiptOutline}
            />
          )}
        />
        <Controller
          name="property_id"
          control={control}
          render={({ field, fieldState }) => (
            <RHFComboBox
              error={fieldState.error}
              {...field}
              name="property_id"
              control={control}
              label="Property"
              options={properties || []}
              placeholder="Select a property..."
              icon={BsHouse}
            />
          )}
        />
        <DateRangePicker
          label="Booking Dates"
          switchMode={false}
          width="w-full"
          defaultStartDate={
            watch("arrival_date") ? new Date(watch("arrival_date")) : null
          }
          defaultEndDate={
            watch("departure_date") ? new Date(watch("departure_date")) : null
          }
          onChange={(range) => {
            setValue("arrival_date", range.startDate);
            setValue("departure_date", range.endDate);
            trigger(["arrival_date", "departure_date"]);
          }}
          error={errors.arrival_date || errors.departure_date}
        />
        <Controller
          name="lead_guest"
          control={control}
          render={({ field, fieldState }) => (
            <TextInput
              label="Lead Guest Name"
              placeholder="e.g. John Doe"
              {...field}
              error={fieldState.error}
              icon={FaUser}
            />
          )}
        />
        <Controller
          name="lead_guest_contact"
          control={control}
          render={({ field, fieldState }) => (
            <TextInput
              label="Guest Contact"
              placeholder="e.g. 07652896541"
              {...field}
              error={fieldState.error}
              icon={HiPhone}
            />
          )}
        />

        <ToggleButton
          icon={TiArrowLoop}
          label="Return Guest"
          checked={watch("is_return_guest")}
          onChange={(checked) => setValue("is_return_guest", checked)}
          trueLabel="Yes"
          falseLabel="No"
        />
      </div>

      <div className="flex shadow-m h-full justify-between p-3 flex-col bg-secondary-bg rounded-2xl">
        <Controller
          name="adults"
          control={control}
          render={({ field, fieldState }) => (
            <NumericInputGroup
              label="Adults"
              value={field.value}
              onChange={field.onChange}
              icon={IoIosMan}
              error={fieldState.error}
            />
          )}
        />
        <Controller
          name="children"
          control={control}
          render={({ field, fieldState }) => (
            <NumericInputGroup
              label="Children"
              value={field.value}
              onChange={field.onChange}
              icon={FaChildren}
              error={fieldState.error}
            />
          )}
        />
        <Controller
          name="infants"
          control={control}
          render={({ field, fieldState }) => (
            <NumericInputGroup
              label="Infants"
              value={field.value}
              onChange={field.onChange}
              icon={MdChildFriendly}
              error={fieldState.error}
            />
          )}
        />
        <Controller
          name="pets"
          control={control}
          render={({ field, fieldState }) => (
            <NumericInputGroup
              label="Pets"
              value={field.value}
              onChange={field.onChange}
              icon={FaDog}
              error={fieldState.error}
            />
          )}
        />
        <Controller
          name="highchairs"
          control={control}
          render={({ field, fieldState }) => (
            <NumericInputGroup
              label="Highchairs"
              value={field.value}
              onChange={field.onChange}
              icon={MdChildFriendly}
              error={fieldState.error}
            />
          )}
        />
        <Controller
          name="cots"
          control={control}
          render={({ field, fieldState }) => (
            <NumericInputGroup
              label="Cots"
              value={field.value}
              onChange={field.onChange}
              icon={FaBed}
              error={fieldState.error}
            />
          )}
        />
        <Controller
          name="stairgates"
          control={control}
          render={({ field, fieldState }) => (
            <NumericInputGroup
              label="Stairgates"
              value={field.value}
              onChange={field.onChange}
              icon={LuFence}
              error={fieldState.error}
            />
          )}
        />
      </div>

      <div className="flex flex-1 gap-4 flex-col">
        <div className="flex flex-1 shadow-m flex-col bg-secondary-bg rounded-2xl p-3"></div>
        <div className="flex flex-row shadow-m gap-3 bg-secondary-bg rounded-2xl p-3">
          <CTAButton
            disabled={!isDirty}
            width="flex-1"
            type="cancel"
            text="Revert Changes"
            icon={IoIosUndo}
            callbackFn={() =>
              id === "New-Booking" ? reset(defaultFormData) : reset(booking)
            }
          />
          <CTAButton
            disabled={
              !isDirty || !isValid || isSubmitting || upsertBooking.isLoading
            }
            width="flex-1"
            type="success"
            text={upsertBooking.isLoading ? "Saving..." : "Save Changes"}
            icon={FaCheck}
            callbackFn={handleSubmit(async (data) => {
              try {
                const payload = id !== "New-Booking" ? { id, ...data } : data;

                console.log("Submitting payload:", payload);
                await upsertBooking.mutateAsync(payload);

                navigate("/Bookings");
              } catch (error) {
                console.error("Save failed:", error.message);
                alert("Failed to save booking: " + error.message);
              }
            })}
          />
        </div>
      </div>
    </div>
  );
};

export default BookingForm;
