import { z } from 'zod';
import { ListQuery } from '../common/pagination';
import { SiteCode } from '../organisations/organisations.schemas';

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const Name = z.string().trim().min(1).max(100);
const TimeZone = z.string().trim().max(64).refine(isTimeZone, 'Unknown IANA time zone');
const Code = SiteCode;

export const Site = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  timezone: z.string(),
  active: z.boolean(),
});
export type Site = z.infer<typeof Site>;

export const CreateSiteBody = z.object({ code: Code, name: Name, timezone: TimeZone.optional() }).strict();
export const UpdateSiteBody = z
  .object({ code: Code.optional(), name: Name.optional(), timezone: TimeZone.optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

export const Department = z.object({
  id: z.string().uuid(),
  siteId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export type Department = z.infer<typeof Department>;

export const CreateDepartmentBody = z.object({ siteId: z.string().uuid(), code: Code, name: Name }).strict();
export const UpdateDepartmentBody = z
  .object({ code: Code.optional(), name: Name.optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

export const SiteListQuery = ListQuery.extend({ includeInactive: booleanFlag });
export const DepartmentListQuery = ListQuery.extend({ siteId: z.string().uuid().optional(), includeInactive: booleanFlag });
