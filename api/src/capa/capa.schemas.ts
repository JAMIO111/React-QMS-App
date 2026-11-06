import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');
const text = (max: number) => z.string().trim().min(1).max(max);

export const STAGES = ['open', 'actions_in_progress', 'awaiting_verification', 'verified_effective', 'closed', 'cancelled'] as const;
export const STEPS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'] as const;
export const SOURCES = ['internal', 'customer', 'supplier'] as const;
export const SEVERITIES = ['critical', 'major', 'minor'] as const;
export const TEAM_ROLES = ['leader', 'champion', 'member', 'supplier_contact', 'customer_contact'] as const;
export const Stage = z.enum(STAGES);
export const Step = z.enum(STEPS);
export const Source = z.enum(SOURCES);
export const Severity = z.enum(SEVERITIES);
export const TeamRole = z.enum(TEAM_ROLES);

// ---- input ---------------------------------------------------------------------------------------

/** Start an 8D. From a non-conformance only that is needed; the NC fills the title, problem statement, source and severity. */
export const CreateCapaBody = z
  .object({
    fromNcrId: z.string().uuid().optional(),
    title: text(200).optional(),
    problemStatement: text(5000).optional(),
    source: Source.optional(),
    severity: Severity.optional(),
  })
  .strict()
  .refine((b) => b.fromNcrId !== undefined || b.title !== undefined, { message: 'Give the 8D a title or start it from a non-conformance' });
export type CreateCapaBody = z.infer<typeof CreateCapaBody>;

const Words = z.string().trim().max(2000).nullable();
export const UpdateCapaBody = z
  .object({
    title: text(200),
    problemStatement: z.string().trim().max(5000).nullable(),
    source: Source,
    severity: Severity.nullable(),
    externalReference: z.string().trim().max(100).nullable(),
    ownerMembershipId: z.string().uuid().nullable(),
    dueDate: DateOnly.nullable(),
    // D2: the 5W2H description
    d2Who: Words,
    d2What: Words,
    d2Where: Words,
    d2When: Words,
    d2Why: Words,
    d2How: Words,
    d2HowMany: Words,
    // D3: why there is no interim containment
    d3NoContainmentReason: Words,
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateCapaBody = z.infer<typeof UpdateCapaBody>;

export const CompleteStepBody = z.object({ step: Step, note: z.string().trim().max(2000).optional() }).strict();
export type CompleteStepBody = z.infer<typeof CompleteStepBody>;
export const ReopenStepBody = z.object({ step: Step, reason: text(2000) }).strict();
export type ReopenStepBody = z.infer<typeof ReopenStepBody>;
export const ReasonBody = z.object({ reason: text(2000) }).strict();
export type ReasonBody = z.infer<typeof ReasonBody>;

export const AddTeamBody = z
  .object({
    membershipId: z.string().uuid().optional(),
    externalName: text(120).optional(),
    externalCompany: z.string().trim().max(120).optional(),
    externalEmail: z.string().trim().max(200).optional(),
    role: TeamRole.default('member'),
  })
  .strict()
  .refine((b) => (b.membershipId === undefined) !== (b.externalName === undefined), { message: 'Name an organisation member or an external contact' })
  .refine((b) => b.membershipId === undefined || ['leader', 'champion', 'member'].includes(b.role), { message: 'A member can be leader, champion or member' });
export type AddTeamBody = z.infer<typeof AddTeamBody>;

export const UpdateTeamBody = z
  .object({
    role: TeamRole,
    externalName: text(120),
    externalCompany: z.string().trim().max(120).nullable(),
    externalEmail: z.string().trim().max(200).nullable(),
    /** The person leaves the team (the record stays). */
    ended: z.literal(true),
  })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateTeamBody = z.infer<typeof UpdateTeamBody>;

// ---- analyses (D2 and D4 tools) -----------------------------------------------------------------

const Cell = z.string().trim().max(1000).default('');
/** Is / Is-Not: rows of questions in four dimensions, each with what it IS, what it IS NOT, what is distinctive and what changed. */
export const IsIsNotData = z
  .object({
    rows: z
      .array(z.object({ key: z.string().trim().min(1).max(40), dimension: z.enum(['what', 'where', 'when', 'extent']), question: z.string().trim().max(200).default(''), is: Cell, isNot: Cell, distinctive: Cell, changes: Cell }).strict())
      .max(30),
  })
  .strict();
export const ANALYSIS_KINDS = ['is_is_not'] as const;
export const AnalysisKind = z.enum(ANALYSIS_KINDS);
/** Each kind's data shape; Ishikawa and 5 Whys join in a later slice. */
export const ANALYSIS_DATA: Record<(typeof ANALYSIS_KINDS)[number], z.ZodType<Record<string, unknown>>> = { is_is_not: IsIsNotData };

export const CreateAnalysisBody = z.object({ kind: AnalysisKind, title: text(200), data: z.record(z.unknown()).default({}) }).strict();
export type CreateAnalysisBody = z.infer<typeof CreateAnalysisBody>;
export const UpdateAnalysisBody = z
  .object({ title: text(200), data: z.record(z.unknown()) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateAnalysisBody = z.infer<typeof UpdateAnalysisBody>;

// ---- actions (D3 now; D5 and D7 later) -----------------------------------------------------------

export const ACTION_PHASES = ['interim'] as const;
export const CreateActionBody = z
  .object({ phase: z.enum(ACTION_PHASES), description: text(2000), ownerTeamMemberId: z.string().uuid().nullable().optional(), dueDate: DateOnly.nullable().optional() })
  .strict();
export type CreateActionBody = z.infer<typeof CreateActionBody>;
export const UpdateActionBody = z
  .object({ description: text(2000), ownerTeamMemberId: z.string().uuid().nullable(), dueDate: DateOnly.nullable(), evidenceNote: z.string().trim().max(2000).nullable() })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type UpdateActionBody = z.infer<typeof UpdateActionBody>;
export const CompleteActionBody = z.object({ evidenceNote: z.string().trim().max(2000).optional() }).strict();
export type CompleteActionBody = z.infer<typeof CompleteActionBody>;

export const LinkNcrBody = z.object({ ncrId: z.string().uuid() }).strict();
export type LinkNcrBody = z.infer<typeof LinkNcrBody>;

export const ListQuery = z.object({
  /** Running (not closed or cancelled) by default; a stage; or all. */
  stage: z.enum(['running', ...STAGES, 'all']).default('running'),
  /** Only 8Ds linked to this non-conformance. */
  ncrId: z.string().uuid().optional(),
  /** Only 8Ds the signed-in person owns. */
  owner: z.enum(['me']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListQuery = z.infer<typeof ListQuery>;

export const PeopleQuery = z.object({ q: z.string().trim().min(1).max(100).optional() });
export type PeopleQuery = z.infer<typeof PeopleQuery>;

// ---- output --------------------------------------------------------------------------------------

const Person = z.object({ id: z.string().uuid(), name: z.string() }).nullable();

export const CapaSummary = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  method: z.literal('8d'),
  title: z.string(),
  stage: Stage,
  stageReason: z.string().nullable(),
  source: Source,
  severity: Severity.nullable(),
  externalReference: z.string().nullable(),
  owner: z.object({ membershipId: z.string().uuid(), name: z.string() }).nullable(),
  dueDate: DateOnly.nullable(),
  overdue: z.boolean(),
  /** The first step not yet complete (D8 once everything is). */
  currentStep: Step,
  stepsDone: z.number().int(),
  ncrCount: z.number().int(),
  createdAt: Iso,
  closedAt: Iso.nullable(),
});
export type CapaSummary = z.infer<typeof CapaSummary>;

export const CapaStep = z.object({
  step: Step,
  completed: z.boolean(),
  completedAt: Iso.nullable(),
  completedBy: Person,
  note: z.string().nullable(),
  reopenedAt: Iso.nullable(),
  reopenReason: z.string().nullable(),
  /** What is still needed before the step can be completed (empty = ready). */
  problems: z.array(z.string()),
});

export const TeamMember = z.object({
  id: z.string().uuid(),
  membershipId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  name: z.string(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  role: TeamRole,
  external: z.boolean(),
  endedAt: Iso.nullable(),
});

export const NcrLink = z.object({
  id: z.string().uuid(),
  nonconformanceId: z.string().uuid(),
  /** Null when the caller cannot read the non-conformance. */
  reference: z.string().nullable(),
  title: z.string().nullable(),
  stage: z.string().nullable(),
  source: z.string().nullable(),
  severity: z.string().nullable(),
  linkedAt: Iso,
  linkedBy: Person,
  endedAt: Iso.nullable(),
  endReason: z.string().nullable(),
});

export const Analysis = z.object({
  id: z.string().uuid(),
  kind: AnalysisKind,
  title: z.string(),
  step: Step,
  data: z.record(z.unknown()),
  createdBy: Person,
  createdAt: Iso,
  updatedAt: Iso,
});

export const Action = z.object({
  id: z.string().uuid(),
  phase: z.enum(['interim', 'corrective', 'preventive']),
  description: z.string(),
  rootCauseId: z.string().uuid().nullable(),
  owner: z.object({ teamMemberId: z.string().uuid(), name: z.string() }).nullable(),
  dueDate: DateOnly.nullable(),
  overdue: z.boolean(),
  status: z.enum(['open', 'done', 'cancelled']),
  doneAt: Iso.nullable(),
  doneBy: Person,
  evidenceNote: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: Iso,
});

export const CapaDetail = CapaSummary.extend({
  problemStatement: z.string().nullable(),
  /** D2: the 5W2H description. */
  problem: z.object({ who: z.string().nullable(), what: z.string().nullable(), where: z.string().nullable(), when: z.string().nullable(), why: z.string().nullable(), how: z.string().nullable(), howMany: z.string().nullable() }),
  /** D3: why there is no interim containment, when there is none. */
  d3NoContainmentReason: z.string().nullable(),
  analyses: z.array(Analysis),
  actions: z.array(Action),
  createdBy: Person,
  updatedAt: Iso,
  steps: z.array(CapaStep),
  team: z.array(TeamMember),
  ncrs: z.array(NcrLink),
});
export type CapaDetail = z.infer<typeof CapaDetail>;

export const CapaList = z.object({ data: z.array(CapaSummary) });
export const PeopleList = z.object({ data: z.array(z.object({ membershipId: z.string().uuid(), userId: z.string().uuid(), name: z.string() })) });
export const NcrCapaList = z.object({
  data: z.array(z.object({ linkId: z.string().uuid(), capaId: z.string().uuid(), reference: z.string(), title: z.string(), stage: Stage, currentStep: Step, stepsDone: z.number().int(), linkedAt: Iso })),
});
