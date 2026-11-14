import { z } from 'zod';

/**
 * How a table-style measurement report is read (docs/cmm-ingestion-plan.md C1). A profile names the heading of each column it needs; the report
 * may start with header lines ("Part number: 123-A") before the table. Saved in `measurement_import_profile_versions.settings`.
 */
const Heading = z.string().trim().min(1).max(200);
const Label = z.string().trim().min(1).max(100);

export const HEADER_FIELDS = ['partNumber', 'serial', 'workOrder', 'lot', 'program', 'operator', 'measuredAt'] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];

export const TableSettings = z
  .object({
    encoding: z.enum(['auto', 'utf-8', 'windows-1252', 'utf-16le', 'utf-16be']).default('auto'),
    delimiter: z.enum(['auto', ',', ';', 'tab', '|']).default('auto'),
    /** The line of the column headings (1 = the first line), or `auto`: the first line holding both the feature and the actual headings. */
    headingRow: z.union([z.literal('auto'), z.number().int().min(1).max(500)]).default('auto'),
    columns: z
      .object({
        feature: Heading,
        actual: Heading.optional(),
        nominal: Heading.optional(),
        /** Tolerances around the nominal (the lower one as written, or always taken away from the nominal: see lowerTolerance). */
        upperTolerance: Heading.optional(),
        lowerTolerance: Heading.optional(),
        /** Or limits as values. */
        upperLimit: Heading.optional(),
        lowerLimit: Heading.optional(),
        unit: Heading.optional(),
        passFail: Heading.optional(),
        balloon: Heading.optional(),
        /** Appended to the feature name ("CIR_1 X"), for exports with one line per axis. */
        axis: Heading.optional(),
        /** A column whose value says which part a line belongs to (serial or part number in a pallet); a new value starts a new part. */
        unitSplit: Heading.optional(),
      })
      .strict()
      .refine((c) => c.actual || c.passFail, { message: 'Name the column of the measured value or of pass / fail' }),
    /** `as_written`: lower limit = nominal + lower tolerance (signed, e.g. -0.05). `minus`: lower limit = nominal − |lower tolerance|. */
    lowerTolerance: z.enum(['as_written', 'minus']).default('as_written'),
    /** Where the balloon number comes from: a column, the number at the start (or end) of the feature name, or nowhere. */
    balloonFrom: z.enum(['column', 'feature', 'none']).default('feature'),
    /** The unit of the values when the file has no unit column. */
    unit: z.string().trim().min(1).max(20).nullable().default(null),
    decimal: z.enum(['.', ',']).default('.'),
    passValues: z.array(z.string().trim().min(1).max(30)).max(20).default(['OK', 'PASS', 'IN', 'GOOD', 'Y', 'YES', 'TRUE']),
    failValues: z.array(z.string().trim().min(1).max(30)).max(20).default(['NOK', 'NG', 'FAIL', 'OUT', 'BAD', 'N', 'NO', 'FALSE']),
    /** Header lines above the table: the words before the value, matched ignoring case ("Part number" finds "Part number: 123-A" or "Part number;123-A"). */
    header: z.object(Object.fromEntries(HEADER_FIELDS.map((f) => [f, Label.optional()])) as Record<HeaderField, z.ZodOptional<typeof Label>>).strict().default({}),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.balloonFrom === 'column' && !s.columns.balloon) ctx.addIssue({ code: 'custom', path: ['columns', 'balloon'], message: 'Name the balloon column' });
    if ((s.columns.upperTolerance || s.columns.lowerTolerance) && !s.columns.nominal)
      ctx.addIssue({ code: 'custom', path: ['columns', 'nominal'], message: 'Tolerances need the nominal column' });
  });
export type TableSettings = z.infer<typeof TableSettings>;

export interface ProfileTemplate {
  key: string;
  name: string;
  description: string;
  format: 'table';
  settings: TableSettings;
}

/**
 * Ready-made starting points, copied into a profile and adjusted with "Try a file". The column names follow the vendors' documentation and must be
 * checked against real exports (plan CM0) — a customer's export can be set up differently.
 */
export const PROFILE_TEMPLATES: ProfileTemplate[] = [
  {
    key: 'calypso_table',
    name: 'ZEISS CALYPSO table file',
    description: 'The characteristics table (…_chr.txt): tab separated, one line per characteristic, tolerances around the nominal.',
    format: 'table',
    settings: TableSettings.parse({
      delimiter: 'tab',
      columns: { feature: 'id', actual: 'actual', nominal: 'nominal', upperTolerance: 'uppertol', lowerTolerance: 'lowertol' },
      lowerTolerance: 'as_written',
      balloonFrom: 'feature',
      unit: 'mm',
    }),
  },
  {
    key: 'pcdmis_csv',
    name: 'Hexagon PC-DMIS CSV export',
    description: 'A PC-DMIS report exported with a heading row: one line per dimension and axis, with + and − tolerances (the minus tolerance written without its sign). A File › Export › Generic text file needs no profile: it is read as it is.',
    format: 'table',
    settings: TableSettings.parse({
      delimiter: 'auto',
      columns: { feature: 'Dimension', axis: 'Axis', actual: 'Measured', nominal: 'Nominal', upperTolerance: '+Tol', lowerTolerance: '-Tol' },
      lowerTolerance: 'minus',
      balloonFrom: 'feature',
      unit: 'mm',
      header: { partNumber: 'Part Name', serial: 'Serial Number' },
    }),
  },
  {
    key: 'generic_limits',
    name: 'Simple table with limits',
    description: 'A spreadsheet or CSV with a balloon number, the measured value and the lower and upper limits.',
    format: 'table',
    settings: TableSettings.parse({
      columns: { feature: 'Feature', balloon: 'Balloon', actual: 'Actual', lowerLimit: 'Lower limit', upperLimit: 'Upper limit' },
      balloonFrom: 'column',
    }),
  },
];
