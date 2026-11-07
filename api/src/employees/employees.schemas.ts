import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const Ref = z.object({ id: z.string().uuid(), code: z.string(), name: z.string() });
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const name = z.string().trim().min(1).max(100);
const email = z
  .string()
  .trim()
  .max(200)
  .email()
  .or(z.literal(''))
  .nullable()
  .transform((v) => v || null)
  .optional();
const id = z.string().uuid().nullable().optional();

export const EMPLOYEE_SORTABLE = ['name', 'jobTitle', 'employeeNumber', 'email', 'site', 'department', 'status', 'createdAt'] as const;

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : []))
    .pipe(z.array(item).max(10));

/** The register: search, filters (lists are comma-separated), server-side sort and page numbers. */
export const EmployeeListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: csv(z.enum(['active', 'inactive'])),
  siteId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  sort: z.enum(EMPLOYEE_SORTABLE).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type EmployeeListQuery = z.infer<typeof EmployeeListQuery>;

export const Employee = z.object({
  id: z.string().uuid(),
  /** First name and surname. */
  name: z.string(),
  firstName: z.string().nullable(),
  surname: z.string().nullable(),
  jobTitle: z.string().nullable(),
  employeeNumber: z.string().nullable(),
  email: z.string().nullable(),
  site: Ref.nullable(),
  department: Ref.nullable(),
  active: z.boolean(),
  /** Has a sign-in to the system (not every employee does). */
  hasLogin: z.boolean(),
  /** The member this record is linked to, if any. Set only by a Controller seat holder. */
  login: z.object({ userId: z.string().uuid(), name: z.string() }).nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Employee = z.infer<typeof Employee>;

export const EmployeePage = z.object({ data: z.array(Employee), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

export const CreateEmployeeBody = z
  .object({ firstName: name, surname: name, jobTitle: text(100), employeeNumber: text(40), email, siteId: id, departmentId: id })
  .strict();
export type CreateEmployeeBody = z.infer<typeof CreateEmployeeBody>;

export const UpdateEmployeeBody = z
  .object({ firstName: name.optional(), surname: name.optional(), jobTitle: text(100), employeeNumber: text(40), email, siteId: id, departmentId: id, active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });
export type UpdateEmployeeBody = z.infer<typeof UpdateEmployeeBody>;

/** Everyone, for pickers (e.g. the responsible employee on a non-conformance). */
export const EmployeeOption = z.object({ id: z.string().uuid(), name: z.string(), jobTitle: z.string().nullable(), active: z.boolean() });

/** Link an employee to a member's sign-in, or remove the link with `userId: null`. */
export const LinkLoginBody = z.object({ userId: z.string().uuid().nullable() }).strict();
export type LinkLoginBody = z.infer<typeof LinkLoginBody>;

/** Members that can be linked to an employee, and whether the caller may link at all (a Controller seat). */
export const LoginCandidates = z.object({
  canLink: z.boolean(),
  data: z.array(z.object({ userId: z.string().uuid(), name: z.string(), email: z.string().nullable(), employeeId: z.string().uuid().nullable() })),
});
