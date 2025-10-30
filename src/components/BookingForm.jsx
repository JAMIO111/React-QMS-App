import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { IoIosMan, IoIosUndo } from "react-icons/io";
import {
  FaChildren,
  FaDog,
  FaBed,
  FaUser,
  FaRegNoteSticky,
} from "react-icons/fa6";
import { PiCrown } from "react-icons/pi";
import { HiPhone } from "react-icons/hi2";
import { TbChairDirector } from "react-icons/tb";
import { BsHouse } from "react-icons/bs";
import { MdChildFriendly } from "react-icons/md";
import { IoReceiptOutline } from "react-icons/io5";
import { LuFence } from "react-icons/lu";
import NumericInputGroup from "./NumericInputGroup";
import TextInput from "./ui/TextInput";
import { BookingFormSchema } from "../validationSchema";
import RHFComboBox from "./ui/RHFComboBox";
import RHFTextArea from "./ui/RHFTextArea";
import { useProperties } from "@/hooks/useProperties";
import { useBookingById } from "@/hooks/useBookingById";
import DateRangePicker from "./ui/DateRangePicker";
import CTAButton from "./CTAButton";
import { FaCheck } from "react-icons/fa";
import { TiArrowLoop } from "react-icons/ti";
import { useUpsertBooking } from "@/hooks/useUpsertBooking";
import ToggleButton from "./ui/ToggleButton";
import { useToast } from "../contexts/ToastProvider";

const defaultFormData = {
  booking_ref: "",
  property_id: null,
  bookingDates: { startDate: null, endDate: null },
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
  notes: "",
  is_return_guest: false,
  is_owner_booking: false,
};

const BookingForm = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { data: booking } = useBookingById(id !== "New-Booking" ? id : null);
  const { data: properties } = useProperties();
  const { showToast } = useToast();

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
      reset({
        ...booking,
        bookingDates: {
          startDate: booking.arrival_date
            ? new Date(booking.arrival_date)
            : null,
          endDate: booking.departure_date
            ? new Date(booking.departure_date)
            : null,
        },
      });
    }
  }, [id, booking, reset]);

  console.log("Form Errors:", errors);
  console.log("Form Dirty:", isDirty);
  console.log("Form Valid:", isValid);

  console.log("Form Values:", watch());

  return (
    <div className="flex bg-primary-bg flex-1 flex-row p-4 gap-4">
      <div className="shadow-m rounded-2xl flex h-full gap-3 flex-1 p-5 flex-col bg-secondary-bg">
        <Controller
          name="booking_ref"
          control={control}
          render={({ field, fieldState }) => (
            <TextInput
              required={true}
              label="Booking Ref."
              placeholder="e.g. EDYA6-13-EN"
              {...field}
              value={field.value || ""}
              onChange={(e) => field.onChange(e.target.value)}
              icon={IoReceiptOutline}
              error={fieldState.error}
            />
          )}
        />
        <Controller
          name="bookingDates"
          control={control}
          render={({ field, fieldState }) => (
            <DateRangePicker
              required={true}
              switchMode={false}
              error={fieldState.error}
              value={field.value || { startDate: null, endDate: null }}
              onChange={field.onChange}
              label="Booking Dates"
              width="w-full"
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
              required={true}
              icon={BsHouse}
            />
          )}
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
        <Controller
          name="is_return_guest"
          control={control}
          render={({ field, fieldState }) => (
            <ToggleButton
              icon={TiArrowLoop}
              label="Return Guest"
              checked={field.value}
              onChange={field.onChange}
              trueLabel="Yes"
              falseLabel="No"
              {...field}
            />
          )}
        />
      </div>

      <div className="flex shadow-m h-full justify-between p-3 flex-col bg-secondary-bg rounded-2xl">
        <Controller
          name="adults"
          control={control}
          render={({ field, fieldState }) => (
            <NumericInputGroup
              label="Adults"
              required={true}
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
              icon={TbChairDirector}
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
        <div className="flex flex-1 gap-3 shadow-m flex-col bg-secondary-bg justify-start rounded-2xl p-3">
          <Controller
            name="notes"
            control={control}
            render={({ field, fieldState }) => (
              <RHFTextArea
                rows={3}
                icon={FaRegNoteSticky}
                label="Notes"
                value={field.value}
                onChange={field.onChange}
                error={fieldState.error}
              />
            )}
          />
          <Controller
            name="is_owner_booking"
            control={control}
            render={({ field, fieldState }) => (
              <ToggleButton
                icon={PiCrown}
                label="Owner Booking"
                checked={field.value}
                onChange={field.onChange}
                trueLabel="Yes"
                falseLabel="No"
              />
            )}
          />
        </div>
        <div className="flex flex-row shadow-m gap-3 bg-secondary-bg rounded-2xl p-3">
          <CTAButton
            disabled={!isDirty}
            width="flex-1"
            type="cancel"
            text="Revert Changes"
            icon={IoIosUndo}
            callbackFn={() =>
              id === "New-Booking"
                ? reset(defaultFormData)
                : reset({
                    ...booking,
                    bookingDates: {
                      startDate: booking?.arrival_date
                        ? new Date(booking.arrival_date)
                        : null,
                      endDate: booking?.departure_date
                        ? new Date(booking.departure_date)
                        : null,
                    },
                  })
            }
          />
          <CTAButton
            disabled={!isDirty || !isValid || isSubmitting}
            width="flex-1"
            type="success"
            text={isSubmitting ? "Saving..." : "Save Changes"}
            icon={FaCheck}
            callbackFn={handleSubmit(async (data) => {
              try {
                const { bookingDates, ...rest } = data;
                const nights =
                  bookingDates?.startDate && bookingDates?.endDate
                    ? Math.round(
                        (new Date(bookingDates.endDate) -
                          new Date(bookingDates.startDate)) /
                          (1000 * 60 * 60 * 24)
                      )
                    : null;

                const payload =
                  id !== "New-Booking"
                    ? {
                        id,
                        ...rest,
                        arrival_date: bookingDates?.startDate || null,
                        departure_date: bookingDates?.endDate || null,
                        nights,
                      }
                    : {
                        ...rest,
                        arrival_date: bookingDates?.startDate || null,
                        departure_date: bookingDates?.endDate || null,
                        nights,
                      };

                console.log("Submitting payload:", payload);
                await upsertBooking.mutateAsync(payload);

                navigate("/Bookings");

                showToast({
                  type: "success",
                  title: id ? "Booking Updated" : "Booking Created",
                  message: id
                    ? "The booking has been successfully updated."
                    : "New booking successfully entered.",
                });
              } catch (error) {
                console.error("Save failed:", error.message);
                if (error.code === "OVERLAP") {
                  showToast({
                    type: "error",
                    title: "Booking Overlap",
                    message: `Failed to save changes: ${error.message}`,
                  });
                }
              }
            })}
          />
        </div>
      </div>
    </div>
  );
};

export default BookingForm;
