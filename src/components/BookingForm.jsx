import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { IoIosMan } from "react-icons/io";
import { FaChildren, FaDog, FaBed, FaUser } from "react-icons/fa6";
import { TbChairDirector } from "react-icons/tb";
import { HiPhone } from "react-icons/hi2";
import { MdChildFriendly } from "react-icons/md";
import { LuFence } from "react-icons/lu";
import NumericInputGroup from "./NumericInputGroup";
import TextInput from "./ui/TextInput";

const defaultFormData = {
  property_id: null,
  arrival_date: "",
  departure_date: "",
  nights: 0,
  lead_guest: "",
  guest_contact: "",
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
    if (id && id !== "New-Booking") {
      // Fetch property details by ID
      fetch(`/api/properties/${id}`)
        .then((res) => res.json())
        .then((data) => setFormData(data));
    }
  }, [id]);

  return (
    <div className="flex bg-primary-bg flex-1 flex-row p-3 gap-3">
      <div className="flex-1">
        <div className="flex h-full gap-3 flex-1 p-5 flex-col bg-secondary-bg border rounded-2xl border-border-color">
          <TextInput
            label="Lead Guest Name"
            value={formData?.name}
            placeholder="Enter lead guest name..."
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            icon={FaUser}
          />
          <TextInput
            label="Guest Contact"
            value={formData?.contact}
            placeholder="Enter guest contact..."
            onChange={(e) =>
              setFormData({ ...formData, contact: e.target.value })
            }
            icon={HiPhone}
          />
        </div>
      </div>
      <div className="flex-1">
        <div className="flex h-full justify-between flex-1 p-3 flex-col bg-secondary-bg border rounded-2xl border-border-color">
          <NumericInputGroup
            label="Adults"
            value={numericValue}
            onChange={setNumericValue}
            icon={IoIosMan}
          />
          <NumericInputGroup
            label="Children"
            value={numericValue}
            onChange={setNumericValue}
            icon={FaChildren}
          />
          <NumericInputGroup
            label="Infants"
            value={numericValue}
            onChange={setNumericValue}
            icon={MdChildFriendly}
          />
          <NumericInputGroup
            label="Pets"
            value={numericValue}
            onChange={setNumericValue}
            icon={FaDog}
          />
          <NumericInputGroup
            label="Highchairs"
            value={numericValue}
            onChange={setNumericValue}
            icon={TbChairDirector}
          />
          <NumericInputGroup
            label="Cots"
            value={numericValue}
            onChange={setNumericValue}
            icon={FaBed}
          />
          <NumericInputGroup
            label="Stairgates"
            value={numericValue}
            onChange={setNumericValue}
            icon={LuFence}
          />
        </div>
      </div>
      <div className="flex flex-1 gap-3 flex-col">
        <img
          className="border border-border-color aspect-video rounded-xl"
          src={"/mansion-1.png"}
          alt={formData?.name}
        />
        <div className="flex flex-1 flex-col bg-secondary-bg border border-border-color rounded-2xl p-3"></div>
      </div>
    </div>
  );
};

export default BookingForm;
