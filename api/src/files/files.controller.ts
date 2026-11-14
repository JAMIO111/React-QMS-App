import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { FilesService, ORGANISATION_BUCKETS } from './files.service';

const Path = z.string().min(1).max(1024);
const UploadBody = z.object({ bucket: z.enum(ORGANISATION_BUCKETS), path: Path }).strict();
const DownloadBody = z
  .object({ bucket: z.enum(ORGANISATION_BUCKETS), path: Path, expiresIn: z.number().int().min(30).max(3600).optional(), downloadName: z.string().min(1).max(255).optional() })
  .strict();
const RemoveBody = z.object({ bucket: z.literal('org-logos'), path: Path }).strict();

/**
 * Upload and download links for the organisation's private files (docs/security-plan.md SE3). Any member may ask; the file's own rule decides
 * (the same function as the storage policies), and the network rule applies like every organisation route.
 */
@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly service: FilesService) {}

  @Post('upload-url')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(UploadBody) })
  @ApiOkResponse({ description: 'A token to upload one file to that path (the path must be in a folder the person may add to). 403 file_not_allowed otherwise' })
  upload(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(UploadBody, body);
    return this.service.uploadLink(ctx, b.bucket, b.path);
  }

  @Post('download-url')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(DownloadBody) })
  @ApiOkResponse({ description: 'A short-lived link to the file (default 10 minutes, at most an hour; five minutes while network restrictions are enforced)' })
  download(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(DownloadBody, body);
    return this.service.downloadLink(ctx, b.bucket, b.path, b.expiresIn, b.downloadName);
  }

  @Post('remove')
  @HttpCode(200)
  @OrganisationScoped()
  @ApiBody({ schema: openApiSchema(RemoveBody) })
  @ApiOkResponse({ description: 'Remove a replaced or cleared organisation logo file (organisation.manage)' })
  remove(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(RemoveBody, body);
    return this.service.remove(ctx, b.bucket, b.path);
  }
}
