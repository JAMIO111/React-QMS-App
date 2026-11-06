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
  ncr_classifications_name_key: 'An entry with this name already exists',
  gauges_org_asset_number_key: 'A gauge with this asset number already exists',
  gauge_types_name_key: 'A gauge type with this name already exists',
  calibration_readings_one_per_characteristic: 'This characteristic already has a reading',
  inspection_measurements_supersedes_key: 'This reading has already been corrected; correct the latest reading instead',
  part_customers_key: 'This customer is already linked to the part',
  control_plan_applicability_target: 'Choose a part family or a part',
  machines_org_code_key: 'A machine with this code already exists',
  part_families_org_code_key: 'A part family with this code already exists',
  part_revision_characteristics_key: 'This revision already has a value for that characteristic key',
  control_plans_org_code_key: 'A control plan with this code already exists',
  control_plan_applicability_scope_key: 'The plan already has this scope entry',
  control_plan_revisions_code_key: 'This plan already has that revision',
  control_plan_revisions_one_open: 'This plan already has a revision in draft or under review; finish or withdraw it first',
  control_plan_revisions_one_effective: 'This plan already has an effective revision',
  control_plan_operations_code_key: 'This revision already has an operation with that code',
  control_plan_characteristics_key: 'This revision already has a characteristic with that key',
  characteristic_applicability_key: 'That part is already listed',
  sampling_rules_one_per_trigger: 'Each sampling trigger can be used once per characteristic',
  capa_team_members_person_key: 'That person is already on the team',
  capa_team_members_one_leader: 'The team already has a leader; change their role first',
  capa_team_members_one_champion: 'The team already has a champion; change their role first',
  capa_ncr_links_live_key: 'That non-conformance is already linked to this 8D',
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
    case 'QM004': // app.check_classification_parent
      return new ApiError(409, 'invalid_classification', pg.message ?? 'That classification change is not allowed');
    case 'QM005': // app.nonconformance_rules (messages are written for users)
      return new ApiError(409, 'ncr_rule', pg.message ?? 'That change is not allowed for this non-conformance');
    case 'QM006': // calibration rules (messages are written for users)
      return new ApiError(409, 'calibration_rule', pg.message ?? 'That change is not allowed for this calibration record');
    case 'QM007': // process control rules (messages are written for users)
      return new ApiError(409, 'control_plan_rule', pg.message ?? 'That change is not allowed for this control plan');
    case 'QM008': // in-process inspection rules (messages are written for users)
      return new ApiError(409, 'inspection_rule', pg.message ?? 'That change is not allowed for this inspection');
    case 'QM009': // subscription seat and package rules (messages are written for users)
      return new ApiError(409, 'subscription_rule', pg.message ?? 'That subscription change is not allowed');
    case 'QM011': // department membership rules (messages are written for users)
      return new ApiError(409, 'department_rule', pg.message ?? 'That department change is not allowed');
    case 'QM012': // quality alert rules (messages are written for users)
      return new ApiError(409, 'documentation_rule', pg.message ?? 'That change is not allowed for this quality alert');
    case 'QM013': // CAPA / 8D rules (messages are written for users)
      return new ApiError(409, 'capa_rule', pg.message ?? 'That change is not allowed for this 8D');
    case 'QM010': // notification type the caller cannot choose
      return new ApiError(404, 'notification_type_not_found', 'That notification type does not exist');
    case 'P0002': // no_data_found raised by app functions
      return ApiError.notFound();
    case '57014': // query_canceled (statement_timeout)
      return new ApiError(503, 'timeout', 'The request took too long, please try again');
    default:
      return undefined;
  }
}
