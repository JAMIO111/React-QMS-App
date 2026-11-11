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
    /** Stripe (billing). Optional: without them billing routes answer 503 billing_unavailable and nothing else changes. Server-side only. */
    STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/, 'must be a Stripe secret or restricted key').optional(),
    STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9]{10,}$/, 'must be a Stripe webhook signing secret').optional(),
    /** The web app's address, for Stripe's return links (Checkout success/cancel, Customer Portal). */
    APP_BASE_URL: z.string().url().optional(),
    /** Protects the scheduled jobs (/internal/cron/*): sent by Vercel Cron as `Authorization: Bearer <CRON_SECRET>`. Unset: the jobs answer 503. Server-side only. */
    CRON_SECRET: z.string().min(20, 'must be at least 20 characters').optional(),
    /** Email notifications (docs/email-oauth-plan.md, E1): unset / none = outbox only (built and queued, marked not sent); resend = Resend's HTTPS API. */
    MAIL_PROVIDER: z.enum(['none', 'resend']).default('none'),
    /** Resend API key (server-side only), needed when MAIL_PROVIDER=resend. */
    RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]{10,}$/, 'must be a Resend API key').optional(),
    /** The sender, e.g. `Fortress QMS <alerts@example.com>`; the domain must be verified with the provider. */
    MAIL_FROM: z.string().max(200).regex(/^([^<>\r\n]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/, 'must be an address, optionally with a name: Name <address>').optional(),
    JWT_AUDIENCE: z.string().default('authenticated'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
    /** Serves the API reference (/api/v1/docs and /openapi.json). Unset: on everywhere except production, so the route map is not public. */
    API_DOCS: z.enum(['true', 'false']).optional(),
    /** How many proxies sit in front of the API (Vercel: 1), so rate limits see the real client address. Unset: 1 in production, else 0. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .refine((e) => e.SUPABASE_URL || e.SUPABASE_JWT_SECRET, {
    message: 'Set SUPABASE_URL (JWKS) and/or SUPABASE_JWT_SECRET (legacy HS256)',
  })
  .refine((e) => e.MAIL_PROVIDER !== 'resend' || (e.RESEND_API_KEY && e.MAIL_FROM), {
    message: 'MAIL_PROVIDER=resend needs RESEND_API_KEY and MAIL_FROM',
  });

export type Env = z.infer<typeof EnvSchema>;

export const docsEnabled = (env: Env): boolean => (env.API_DOCS ? env.API_DOCS === 'true' : env.NODE_ENV !== 'production');
export const trustProxyHops = (env: Env): number => env.TRUST_PROXY_HOPS ?? (env.NODE_ENV === 'production' ? 1 : 0);

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

/**
 * Allowed browser origins. An entry may contain `*` to match one DNS label fragment, e.g.
 * `https://qms-web-*.vercel.app` for Vercel preview addresses; `*` never matches `.` or `/`.
 */
export function corsOrigins(env: Env): (string | RegExp)[] {
  return env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) =>
      o.includes('*')
        ? new RegExp(`^${o.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]*')}$`)
        : o,
    );
}
