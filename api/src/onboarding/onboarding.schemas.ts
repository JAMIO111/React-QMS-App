import { z } from 'zod';

export const STEP_KEYS = ['organisation', 'plan', 'details', 'sites', 'security', 'team', 'review'] as const;
export const StepKey = z.enum(STEP_KEYS);

/** Only these steps are marked by the owner; organisation, plan, sites and review are worked out from what exists. */
export const MarkableStep = z.enum(['details', 'security', 'team']);

export const SetStepBody = z.object({ step: MarkableStep, status: z.enum(['done', 'skipped', 'pending']) }).strict();
export type SetStepBody = z.infer<typeof SetStepBody>;

export const OnboardingState = z.object({
  billingRequired: z.boolean(),
  accessState: z.enum(['open', 'needs_subscription', 'lapsed']).nullable(),
  /** The first step still to do (review when everything else is). */
  currentStep: StepKey,
  steps: z.array(z.object({ key: StepKey, status: z.enum(['done', 'skipped', 'pending']), required: z.boolean(), auto: z.boolean() })),
  /** Everything required is in place: the wizard can be finished. */
  canFinish: z.boolean(),
  completedAt: z.string().nullable(),
  sites: z.number().int(),
});
export type OnboardingState = z.infer<typeof OnboardingState>;
