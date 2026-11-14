import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error';
import type { RequestContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { FileLinkSigner } from './file-links';

/** The organisation buckets (every one keeps its files under <organisation id>/…). Avatars are the person's own and stay in the browser. */
export const ORGANISATION_BUCKETS = [
  'audit-files',
  'calibration-files',
  'capa-files',
  'competence-files',
  'document-files',
  'inspection-files',
  'integration-files',
  'nc-files',
  'org-logos',
  'quality-alert-files',
  'supplier-files',
] as const;
export type OrganisationBucket = (typeof ORGANISATION_BUCKETS)[number];

/** Longest download link: an hour normally, five minutes while the organisation enforces its network policy (a link works anywhere until it expires). */
export const MAX_LINK_SECONDS = 3600;
export const MAX_LINK_SECONDS_ENFORCED = 300;
export const DEFAULT_LINK_SECONDS = 600;

/** A path inside the organisation's own folder: no empty, "." or ".." segments, no backslashes or control characters. */
export function pathProblem(organisationId: string, path: string): string | null {
  if (path.length > 1024) return 'The path is too long';
  if (!path.startsWith(`${organisationId}/`)) return 'The file is not in this organisation';
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return 'The path has characters that are not allowed';
  const segments = path.split('/');
  if (segments.length < 3 || segments.some((s) => s === '' || s === '.' || s === '..')) return 'The path is not valid';
  return null;
}

/**
 * File links through the API (docs/security-plan.md SE3). OrganisationGuard has already checked membership and the network; this checks the
 * file's own rule as the person (app.storage_file_allowed, the same function the storage policies use), then signs a short-lived link.
 */
@Injectable()
export class FilesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly signer: FileLinkSigner,
  ) {}

  private org(ctx: RequestContext) {
    if (!ctx.organisationId) throw new Error('organisation-scoped route without an organisation');
    return ctx.organisationId;
  }

  private ready() {
    if (!this.signer.enabled) throw new ApiError(503, 'file_storage_unavailable', 'File links are not set up on this server yet');
  }

  /** Checks the path and the rule; answers the organisation's network policy. */
  private async check(ctx: RequestContext, bucket: OrganisationBucket, path: string, write: boolean) {
    const problem = pathProblem(this.org(ctx), path);
    if (problem) throw ApiError.badRequest('invalid_path', problem);
    const r = await this.database.asUser(ctx, (db) =>
      db.execute<{ allowed: boolean; policy: string | null }>(sql`
        select app.storage_file_allowed(${bucket}, ${path}, ${write}) as allowed,
               (select network_policy from public.organisation_settings where organisation_id = ${this.org(ctx)}::uuid) as policy`),
    );
    const row = r.rows[0];
    if (!row?.allowed) {
      throw new ApiError(403, 'file_not_allowed', write ? 'You cannot add a file there' : 'You cannot open this file');
    }
    return { policy: row.policy ?? 'off' };
  }

  async uploadLink(ctx: RequestContext, bucket: OrganisationBucket, path: string) {
    this.ready();
    await this.check(ctx, bucket, path, true);
    const signed = await this.signer.signUpload(bucket, path);
    return { bucket, path, token: signed.token, signedUrl: signed.signedUrl };
  }

  async downloadLink(ctx: RequestContext, bucket: OrganisationBucket, path: string, expiresIn?: number, downloadName?: string) {
    this.ready();
    const { policy } = await this.check(ctx, bucket, path, false);
    const max = policy === 'enforce' ? MAX_LINK_SECONDS_ENFORCED : MAX_LINK_SECONDS;
    const seconds = Math.min(expiresIn ?? DEFAULT_LINK_SECONDS, max);
    const url = await this.signer.signDownload(bucket, path, seconds, downloadName);
    if (!url) throw ApiError.notFound('file_not_found', 'File not found');
    return { url, expiresIn: seconds, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
  }

  /** Logos are the one organisation bucket whose files are removed (a replaced or cleared logo). Needs organisation.manage, as the policy does. */
  async remove(ctx: RequestContext, bucket: 'org-logos', path: string) {
    this.ready();
    await this.check(ctx, bucket, path, true);
    await this.signer.remove(bucket, path);
    return { removed: true };
  }
}
