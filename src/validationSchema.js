import { z } from "zod";

export const PropertyFormSchema = z.object({
  name: z
    .string({ required_error: "Property name is required" })
    .min(1, { message: "Property name must be at least 1 character long" })
    .max(40, {
      message: "Property name must not be more than 40 characters long",
    }),
  bedrooms: z
    .number({ required_error: "Number of bedrooms is required" })
    .min(1),
  sleeps: z.number({ required_error: "Number of sleeps is required" }).min(1),
  bathrooms: z
    .number({ required_error: "Number of bathrooms is required" })
    .min(1),
  line_1: z
    .string({ required_error: "Address line 1 is required" })
    .min(2, { message: "Address line 1 must be at least 2 characters long" })
    .max(100, {
      message: "Address line 1 must not be more than 100 characters long",
    })
    .optional(),
  line_2: z
    .string({ required_error: "Address line 2 is required" })
    .min(2, { message: "Address line 2 must be at least 2 characters long" })
    .max(100, {
      message: "Address line 2 must not be more than 100 characters long",
    })
    .optional(),
  town: z.string({ required_error: "Town is required" }).min(2).max(100),
  county: z.string({ required_error: "County is required" }).min(2).max(100),
  postcode: z
    .string()
    .regex(
      /^([Gg][Ii][Rr]0[Aa]{2})|((([A-Za-z][0-9]{1,2})|(([A-Za-z][A-Ha-hJ-Yj-y][0-9]{1,2})|(([A-Za-z][0-9][A-Za-z])|([A-Za-z][A-Ha-hJ-Yj-y][0-9]?[A-Za-z]))))\s?[0-9][A-Za-z]{2})$/,
      "Invalid UK postcode"
    )
    .transform((val) =>
      val
        .replace(/\s+/g, "")
        .replace(/(.{3})$/, " $1")
        .toUpperCase()
    ),
  what_3_words: z
    .string({ required_error: "What3Words address is required" })
    .regex(
      /^(?:\/\/\/)?[a-z]+(?:-[a-z]+)?\.[a-z]+(?:-[a-z]+)?\.[a-z]+(?:-[a-z]+)?$/,
      "Enter a valid What3Words address"
    ),
  KeyCodes: z
    .array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(2).max(30),
        is_private: z.boolean(),
      })
    )
    .optional(),
});

const phoneRegex = /^[+()\-0-9\s]{6,20}$/;

export const OwnerFormSchema = z.object({
  first_name: z.string({ required_error: "First name is required" }).max(30, {
    message: "First name must not be more than 30 characters long",
  }),
  surname: z
    .string({ required_error: "Surname is required" })
    .max(30, { message: "Surname must not be more than 30 characters long" }),
  middle_name: z
    .string()
    .max(30, {
      message: "Middle name must not be more than 30 characters long",
    })
    .optional()
    .nullable()
    .or(z.literal("")), // ✅ allow blank strings
  primary_email: z
    .string()
    .email({ message: "Invalid email address" })
    .max(100, { message: "Email must not be more than 100 characters long" })
    .optional()
    .nullable()
    .or(z.literal("")), // ✅ allow blank strings
  primary_phone: z
    .string()
    .regex(phoneRegex, { message: "Invalid phone number format" })
    .min(6, { message: "Phone number must be at least 6 characters long" })
    .max(20, {
      message: "Phone number must not be more than 20 characters long",
    })
    .optional()
    .nullable()
    .or(z.literal("")), // ✅ allow blank strings
  secondary_email: z
    .string()
    .email({ message: "Invalid email address" })
    .max(100, { message: "Email must not be more than 100 characters long" })
    .optional()
    .nullable()
    .or(z.literal("")) // ✅ allow blank strings
    .transform((val) => (val === "" ? null : val)), // ✅ transform blank strings to null
  secondary_phone: z
    .string()
    .regex(phoneRegex, { message: "Invalid phone number format" })
    .min(6, { message: "Phone number must be at least 6 characters long" })
    .max(20, {
      message: "Phone number must not be more than 20 characters long",
    })
    .optional()
    .nullable()
    .or(z.literal("")), // ✅ allow blank strings
  is_active: z.boolean().default(true),
  location: z.any().nullable().optional().nullable(),
});

export const BookingFormSchema = z.object({
  property_id: z.string({ required_error: "Property is required" }),

  booking_ref: z
    .string()
    .max(50, { message: "Booking reference must not exceed 50 characters" }),

  arrival_date: z
    .string({ required_error: "Arrival date is required" })
    .refine((val) => !isNaN(Date.parse(val)), {
      message: "Invalid date format",
    }),

  departure_date: z
    .string({ required_error: "Departure date is required" })
    .refine((val) => !isNaN(Date.parse(val)), {
      message: "Invalid date format",
    })
    .refine(
      (val, ctx) => {
        const arrivalDate = new Date(ctx.parent.arrival_date);
        const departureDate = new Date(val);
        return departureDate > arrivalDate;
      },
      { message: "Departure date must be after arrival date" }
    ),

  nights: z.preprocess(
    (val) => (typeof val === "string" ? parseInt(val, 10) : val),
    z.number().min(1, { message: "Nights must be at least 1" })
  ),

  lead_guest: z
    .string()
    .min(2, { message: "Lead guest name must be at least 2 characters long" })
    .max(50, {
      message: "Lead guest name must not be more than 50 characters long",
    }),
});
