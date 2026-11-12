import { z } from 'zod';

export const SiteCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/, 'Use 1–20 letters, digits, "-" or "_"')
  .transform((v) => v.toUpperCase());

/** Accent colours an organisation can choose; the frontend maps each to light/normal/dark shades. */
export const THEME_COLOURS = ['blue', 'red', 'yellow', 'green', 'orange', 'purple', 'pink'] as const;
export const ThemeColour = z.enum(THEME_COLOURS);

export const OrganisationResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['active', 'suspended']),
  legalName: z.string().nullable(),
  /** ISO 3166-1 alpha-2, upper case. */
  country: z.string().nullable(),
  settings: z.object({
    baseCurrency: z.string(),
    vatRate: z.number(),
    ncrReferencePrefix: z.string(),
    themeColour: ThemeColour,
    requireMfa: z.boolean(),
    /** Lots and serial numbers are used (Production menu, pickers). Off for shops that work to work orders only. */
    useLotsAndSerials: z.boolean(),
    /** People who only record inspections may create a production order from a job. */
    allowInlineOrders: z.boolean(),
    /** A job cannot be completed without a production order. */
    requireProductionOrder: z.boolean(),
    /** The formula editor and the import template manager are shown (UI2c). */
    advancedImports: z.boolean(),
    /** When the daily reminders go out (HH:MM, WK2), in `timeZone`. */
    reminderTime: z.string(),
    /** The organisation's own time zone; null = its first site's. `effectiveTimeZone` is the one in use. */
    timeZone: z.string().nullable(),
    effectiveTimeZone: z.string(),
    /** Path of the logo in the private org-logos bucket (<organisation id>/logo/...), or null. */
    logoPath: z.string().nullable(),
  }),
});
export type OrganisationResponse = z.infer<typeof OrganisationResponse>;

const Country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code')
  .transform((v) => v.toUpperCase());

export const CreateOrganisationBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    /** IANA time zone of the first site (e.g. Europe/London); the database checks it exists. */
    timeZone: z.string().trim().min(1).max(60).optional(),
    country: Country.optional(),
    site: z
      .object({ name: z.string().trim().min(1).max(100), code: SiteCode })
      .strict()
      .optional(),
  })
  .strict();
export type CreateOrganisationBody = z.infer<typeof CreateOrganisationBody>;

export const UpdateOrganisationBody = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    legalName: z.string().trim().max(200).nullable().optional(),
    country: Country.nullable().optional(),
    settings: z
      .object({
        baseCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a 3-letter ISO currency code').transform((v) => v.toUpperCase()).optional(),
        vatRate: z.number().min(0).lt(1).multipleOf(0.0001).optional(),
        ncrReferencePrefix: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, 'Use 1–10 letters or digits').transform((v) => v.toUpperCase()).optional(),
        themeColour: ThemeColour.optional(),
        requireMfa: z.boolean().optional(),
        useLotsAndSerials: z.boolean().optional(),
        allowInlineOrders: z.boolean().optional(),
        requireProductionOrder: z.boolean().optional(),
        advancedImports: z.boolean().optional(),
        /** HH:MM, on a five-minute step. */
        reminderTime: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5][05]$/, 'Use HH:MM on a five-minute step').optional(),
        /** An IANA time zone (the database refuses an unknown one); null = the first site's. */
        timeZone: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .refine((z) => {
            try {
              new Intl.DateTimeFormat('en-GB', { timeZone: z });
              return true;
            } catch {
              return false;
            }
          }, 'Unknown time zone')
          .nullable()
          .optional(),
        /** Set after uploading to org-logos at <organisation id>/logo/...; null removes the logo. */
        logoPath: z.string().trim().max(300).nullable().optional(),
      })
      .strict()
      .refine((s) => Object.keys(s).length > 0, { message: 'Provide at least one setting' })
      .optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.legalName !== undefined || b.country !== undefined || b.settings !== undefined, { message: 'Provide something to change' });
export type UpdateOrganisationBody = z.infer<typeof UpdateOrganisationBody>;

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/, 'Idempotency-Key must be 1–200 safe characters');
