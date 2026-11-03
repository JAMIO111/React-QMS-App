import { z } from 'zod';

export const ENV = Symbol('ENV');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    /** Enables JWKS verification (asymmetric Supabase signing keys) and sets the default issuer. */
    SUPABASE_URL: z.string().url().optional(),
    /** Legacy shared HS256 secret; only for projects that have not moved to signing keys. */
    SUPABASE_JWT_SECRET: z.string().min(32).optional(),
    JWT_ISSUER: z.string().optional(),
    /** Optional: lets the API send invitation emails through Supabase Auth. Server-side only. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    /** Where invitation emails send people (the frontend's sign-in page). */
    INVITE_REDIRECT_URL: z.string().url().optional(),
    JWT_AUDIENCE: z.string().default('authenticated'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .refine((e) => e.SUPABASE_URL || e.SUPABASE_JWT_SECRET, {
    message: 'Set SUPABASE_URL (JWKS) and/or SUPABASE_JWT_SECRET (legacy HS256)',
  });

export type Env = z.infer<typeof EnvSchema>;

/** Validates configuration at start-up; secrets are never echoed in the error. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(
    Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === '' ? undefined : v])),
  );
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`);
    throw new Error(`Invalid API configuration — ${issues.join('; ')}`);
  }
  return parsed.data;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
}
