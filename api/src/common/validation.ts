import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ApiError } from './api-error';

/** Validates input against a zod schema; failures become 400 validation_failed with field issues. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw ApiError.badRequest(
      'validation_failed',
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** OpenAPI 3 schema object for a zod schema, for @ApiBody / @ApiOkResponse. */
// zodToJsonSchema's generic signature triggers "type instantiation is excessively deep"; call it
// through a plain signature.
const toJsonSchema = zodToJsonSchema as unknown as (schema: z.ZodTypeAny, options: { target: 'openApi3' }) => Record<string, unknown>;

export function openApiSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = toJsonSchema(schema, { target: 'openApi3' });
  return rest;
}

export const Uuid = z.string().uuid();
