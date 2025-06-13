import { z } from "zod";

export const NCMFormSchema = z
  .object({
    ncm_id: z.string({ required_error: "NCM ID Required" }),
    date: z.date({ required_error: "You must enter a date" }).max(new Date(), {
      message: "Date cannot be in the future",
    }),
    customer: z.preprocess(
      (val) => (val === "" ? null : val),
      z
        .string({
          required_error: "Customer is required",
          invalid_type_error: "Must be a string",
        })
        .nullable()
        .optional()
    ),
    work_order: z.preprocess(
      (val) => (val === "" ? null : val),
      z
        .string({
          required_error: "Work order is required",
          invalid_type_error: "Must be a string",
        })
        .nullable()
        .optional()
    ),
    part_number: z.preprocess(
      (val) => (val === "" ? null : val),
      z
        .string({
          required_error: "Part number is required",
          invalid_type_error: "Must be a string",
        })
        .nullable()
        .optional()
    ),
    quantity_checked: z.preprocess(
      (val) => {
        if (val === "") return undefined;
        return val;
      },
      z
        .number({
          required_error: "Quantity checked is required",
          invalid_type_error: "Must be numeric",
        })
        .gt(0, { message: "Quantity checked must be greater than 0" })
    ),

    quantity_defective: z.preprocess(
      (val) => {
        if (val === "") return undefined;
        return val;
      },
      z
        .number({
          required_error: "Defective quantity is required",
          invalid_type_error: "Must be numeric",
        })
        .gt(0, { message: "Amount must be greater than 0" })
    ),
    description: z.preprocess(
      (val) => (val === "" ? undefined : val),
      z
        .string({ required_error: "You must enter a description of the NC." })
        .min(1, { message: "Description cannot be empty" })
        .max(500, { message: "Description cannot exceed 500 characters" })
    ),
    failure_mode: z.number({
      required_error: "Failure mode is required",
      invalid_type_error: "Failure mode required",
    }),
    sub_failure_mode: z.number({
      required_error: "Sub-failure mode required",
      invalid_type_error: "Sub-failure mode required",
    }),
    causal_process: z.number({
      required_error: "Causal process required",
      invalid_type_error: "Causal process required",
    }),
    location_detected: z.number({
      required_error: "Detection location required",
      invalid_type_error: "Detection location required",
    }),
    responsible_operator: z
      .string({
        required_error: "Responsible operator required",
        invalid_type_error: "Must be a uuid string",
      })
      .nullable(),
    status: z.number({
      required_error: "Status is required",
      invalid_type_error: "Status is required",
    }),
  })
  .superRefine((data, ctx) => {
    const { quantity_checked, quantity_defective } = data;

    if (quantity_defective > quantity_checked) {
      ctx.addIssue({
        path: ["quantity_defective"],
        code: z.ZodIssueCode.custom,
        message: "Defective quantity cannot exceed quantity checked",
      });
    }
  });

export const NCCostSchema = z.object({
  type: z.number({
    required_error: "Cost type is required",
    invalid_type_error: "Cost type is required",
  }),
  currency: z
    .string({
      required_error: "Currency is required",
      invalid_type_error: "Currency is required",
    })
    .nonempty("Currency is required"),
  vat: z
    .string({
      required_error: "VAT option is required",
      invalid_type_error: "VAT option is required",
    })
    .nonempty("VAT option is required"),
  vat_rate: z
    .number({
      required_error: "VAT rate is required",
      invalid_type_error: "Must be a number",
    })
    .min(0, { message: "VAT rate cannot be negative" })
    .max(100, { message: "VAT rate cannot exceed 100%" }),
  cost_amount: z
    .number({
      required_error: "Cost is required",
      invalid_type_error: "Must be a number",
    })
    .min(0, { message: "Cost cannot be negative" }),
});
