import { ApiError } from './api-error';

/** Postgres error fields we rely on (node-postgres DatabaseError, possibly wrapped by Drizzle). */
interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

function pgErrorOf(error: unknown): PgError | undefined {
  const candidates = [error, (error as { cause?: unknown })?.cause];
  for (const c of candidates) {
    if (c && typeof c === 'object' && typeof (c as PgError).code === 'string' && /^[0-9A-Z]{5}$/.test((c as PgError).code!)) {
      return c as PgError;
    }
  }
  return undefined;
}

/** Friendly messages for tenant-scoped unique constraints. */
const UNIQUE_MESSAGES: Record<string, string> = {
  sites_org_code_key: 'A site with this code already exists',
  departments_site_code_key: 'A department with this code already exists at this site',
  organisations_slug_key: 'An organisation with this slug already exists',
  organisation_users_pending_invite_key: 'This email address already has a pending invitation',
  organisation_users_org_user_key: 'This person is already a member of the organisation',
  ura_unique: 'This member already has that role',
  customers_org_code_key: 'A customer with this code already exists',
  suppliers_org_code_key: 'A supplier with this code already exists',
  parts_org_part_number_key: 'A part with this number already exists',
  part_revisions_part_revision_key: 'This part already has that revision',
};

/**
 * Maps database errors to API errors with stable codes. Returns undefined for anything that is not
 * a recognised database error (the caller then treats it as an internal error, without details).
 */
export function apiErrorFromDatabase(error: unknown): ApiError | undefined {
  const pg = pgErrorOf(error);
  if (!pg) return undefined;
  switch (pg.code) {
    case '23505': // unique_violation
      return new ApiError(409, pg.constraint === 'organisation_users_pending_invite_key' ? 'already_invited' : 'conflict', UNIQUE_MESSAGES[pg.constraint ?? ''] ?? 'This conflicts with an existing record', {
        constraint: pg.constraint,
      });
    case '23503': // foreign_key_violation (e.g. a site from another organisation)
      return ApiError.badRequest('invalid_reference', 'A referenced record does not exist');
    case '23514': // check_violation
    case '22P02': // invalid_text_representation
    case '22001': // string_data_right_truncation
      return ApiError.badRequest('invalid_value', 'A value is not allowed');
    case '42501': // insufficient_privilege, incl. "new row violates row-level security policy"
      return ApiError.forbidden();
    case '54000': // program_limit_exceeded (abuse limits)
      return new ApiError(429, 'limit_reached', 'A usage limit was reached, please try again later');
    case 'QM001': // app.assert_organisation_has_owner
      return new ApiError(409, 'last_owner', 'An organisation must keep at least one active Owner');
    case 'QM002': // app.guard_require_mfa
      return new ApiError(409, 'mfa_setup_required', 'Set up two-factor authentication for your own account before requiring it');
    case 'QM003': // app.part_revision_lifecycle (message is written for users)
      return new ApiError(409, 'invalid_revision_state', pg.message ?? 'That change is not allowed for this revision');
    case 'P0002': // no_data_found raised by app functions
      return ApiError.notFound();
    case '57014': // query_canceled (statement_timeout)
      return new ApiError(503, 'timeout', 'The request took too long, please try again');
    default:
      return undefined;
  }
}
