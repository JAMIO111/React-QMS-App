import { z } from 'zod';

const Level = z.number().int().min(1).max(10);
const ScaleLevel = z.object({ label: z.string().trim().min(1).max(40), criteria: z.string().trim().max(300).optional() }).strict();
const Scale = z.object({ severity: z.array(ScaleLevel).length(10), occurrence: z.array(ScaleLevel).length(10), detection: z.array(ScaleLevel).length(10) }).strict();

export const ApRuleSchema = z
  .object({ sFrom: Level, sTo: Level, oFrom: Level, oTo: Level, dFrom: Level, dTo: Level, priority: z.enum(['high', 'medium', 'low']) })
  .strict();

/** The organisation's rating model. The database is the one definition of valid (`app.fmea_model_problem`); this only shapes the request. */
export const FmeaModelConfig = z
  .object({
    method: z.enum(['rpn', 'ap']),
    rpnHighFrom: z.number().int().min(2).max(1000),
    rpnMediumFrom: z.number().int().min(1).max(999),
    severityFloor: Level,
    reviewMonths: z.number().int().min(1).max(120),
    scales: z.object({ design: Scale, process: Scale }).strict(),
    apRules: z.array(ApRuleSchema).max(300),
  })
  .strict();
export type FmeaModelConfig = z.infer<typeof FmeaModelConfig>;

export const SaveFmeaModelBody = z.object({ config: FmeaModelConfig, reason: z.string().trim().min(3).max(1000) }).strict();
export type SaveFmeaModelBody = z.infer<typeof SaveFmeaModelBody>;

export const PreviewBody = z
  .object({ kind: z.enum(['design', 'process']), severity: Level, occurrence: Level, detection: Level, version: z.number().int().min(1).optional() })
  .strict();
export type PreviewBody = z.infer<typeof PreviewBody>;

export const ApImportBody = z.object({ csv: z.string().max(200_000) }).strict();
export type ApImportBody = z.infer<typeof ApImportBody>;
