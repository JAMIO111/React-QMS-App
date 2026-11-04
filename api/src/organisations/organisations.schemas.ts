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
  settings: z.object({
    baseCurrency: z.string(),
    vatRate: z.number(),
    ncrReferencePrefix: z.string(),
    themeColour: ThemeColour,
    requireMfa: z.boolean(),
    /** Path of the logo in the private org-logos bucket (<organisation id>/logo/...), or null. */
    logoPath: z.string().nullable(),
  }),
});
export type OrganisationResponse = z.infer<typeof OrganisationResponse>;

export const CreateOrganisationBody = z
  .object({
    name: z.string().trim().min(2).max(100),
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
    settings: z
      .object({
        baseCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a 3-letter ISO currency code').transform((v) => v.toUpperCase()).optional(),
        vatRate: z.number().min(0).lt(1).multipleOf(0.0001).optional(),
        ncrReferencePrefix: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, 'Use 1–10 letters or digits').transform((v) => v.toUpperCase()).optional(),
        themeColour: ThemeColour.optional(),
        requireMfa: z.boolean().optional(),
        /** Set after uploading to org-logos at <organisation id>/logo/...; null removes the logo. */
        logoPath: z.string().trim().max(300).nullable().optional(),
      })
      .strict()
      .refine((s) => Object.keys(s).length > 0, { message: 'Provide at least one setting' })
      .optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.settings !== undefined, { message: 'Provide name and/or settings' });
export type UpdateOrganisationBody = z.infer<typeof UpdateOrganisationBody>;

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/, 'Idempotency-Key must be 1–200 safe characters');
