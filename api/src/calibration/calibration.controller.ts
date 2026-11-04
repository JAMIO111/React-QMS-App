import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import { CalibrationRecordsService } from './calibration-records.service';
import {
  Attachment,
  CalibrationDetail,
  CalibrationSummary,
  Characteristic,
  CharacteristicQuery,
  CreateAttachmentBody,
  CreateCalibrationBody,
  CreateCharacteristicBody,
  CreateGaugeBody,
  CreateGaugeTypeBody,
  DeleteBody,
  DeletedQuery,
  GAUGE_SORTABLE,
  GaugeDetail,
  GaugeListQuery,
  GaugePage,
  GaugeType,
  GaugeTypeQuery,
  HistoryEntry,
  RaisedNcr,
  UpdateCalibrationBody,
  UpdateCharacteristicBody,
  UpdateGaugeBody,
  UpdateGaugeTypeBody,
} from './calibration.schemas';
import { CalibrationService } from './calibration.service';

// Site-scoped role assignments count: RLS then shows only the gauges of the user's sites.
const SITE_SCOPED = { anyScope: true };
const deletedQuery = () => ApiQuery({ name: 'deleted', required: false, enum: ['exclude', 'include', 'only'] });
const includeInactive = () => ApiQuery({ name: 'includeInactive', required: false, schema: { type: 'boolean' } });

@ApiTags('calibration')
@ApiBearerAuth()
@Controller('gauges')
export class GaugesController {
  constructor(
    private readonly service: CalibrationService,
    private readonly records: CalibrationRecordsService,
  ) {}

  @Get()
  @OrganisationScoped('calibration.read', SITE_SCOPED)
  @ApiQuery({ name: 'q', required: false, description: 'Search asset number, description, serial, make, model, location, type' })
  @ApiQuery({ name: 'status', required: false, description: 'Comma-separated statuses' })
  @ApiQuery({ name: 'due', required: false, description: 'Comma-separated: overdue, due_30, due_90, not_set' })
  @ApiQuery({ name: 'outcome', required: false, description: 'Comma-separated outcomes of the latest calibration' })
  @ApiQuery({ name: 'typeId', required: false })
  @ApiQuery({ name: 'siteId', required: false })
  @ApiQuery({ name: 'supplierId', required: false })
  @ApiQuery({ name: 'source', required: false, enum: ['internal', 'external'] })
  @ApiQuery({ name: 'from', required: false, description: 'Next due on or after (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Next due on or before (YYYY-MM-DD)' })
  @deletedQuery()
  @ApiQuery({ name: 'sort', required: false, enum: [...GAUGE_SORTABLE] })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiOkResponse({ schema: openApiSchema(GaugePage) })
  list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.list(ctx, parse(GaugeListQuery, query));
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped('calibration.manage', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateGaugeBody) })
  @ApiCreatedResponse({ schema: openApiSchema(GaugeDetail) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.create(ctx, parse(CreateGaugeBody, body));
  }

  @Get(':id')
  @OrganisationScoped('calibration.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(GaugeDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch(':id')
  @OrganisationScoped('calibration.manage', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(UpdateGaugeBody) })
  @ApiOkResponse({ schema: openApiSchema(GaugeDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(ctx, parse(Uuid, id), parse(UpdateGaugeBody, body));
  }

  /** Soft delete (kept for the record, hidden from the register). */
  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped('calibration.manage', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ schema: openApiSchema(GaugeDetail) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.remove(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped('calibration.manage', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(GaugeDetail) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.restore(ctx, parse(Uuid, id));
  }

  /** Changes to the gauge and its characteristics (audit trail). */
  @Get(':id/history')
  @OrganisationScoped('calibration.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(HistoryEntry) })) })
  async history(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.service.history(ctx, parse(Uuid, id)) };
  }

  @Get(':id/characteristics')
  @OrganisationScoped('calibration.read', SITE_SCOPED)
  @includeInactive()
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Characteristic) })) })
  async listCharacteristics(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listGaugeCharacteristics(ctx, parse(Uuid, id), parse(CharacteristicQuery, query)) };
  }

  @Post(':id/characteristics')
  @HttpCode(201)
  @OrganisationScoped('calibration.manage', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateCharacteristicBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Characteristic) })
  createCharacteristic(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createGaugeCharacteristic(ctx, parse(Uuid, id), parse(CreateCharacteristicBody, body));
  }

  @Get(':id/calibrations')
  @OrganisationScoped('calibration.read', SITE_SCOPED)
  @deletedQuery()
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(CalibrationSummary) })) })
  async listCalibrations(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.records.list(ctx, parse(Uuid, id), parse(DeletedQuery, query)) };
  }

  /** Record a calibration with its readings; the outcome and the gauge's dates/status follow. */
  @Post(':id/calibrations')
  @HttpCode(201)
  @OrganisationScoped('calibration.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateCalibrationBody) })
  @ApiCreatedResponse({ schema: openApiSchema(CalibrationDetail) })
  createCalibration(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.records.create(ctx, parse(Uuid, id), parse(CreateCalibrationBody, body));
  }
}

@ApiTags('calibration')
@ApiBearerAuth()
@Controller('gauge-characteristics')
export class GaugeCharacteristicsController {
  constructor(private readonly service: CalibrationService) {}

  @Patch(':id')
  @OrganisationScoped('calibration.manage', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(UpdateCharacteristicBody) })
  @ApiOkResponse({ schema: openApiSchema(Characteristic) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateGaugeCharacteristic(ctx, parse(Uuid, id), parse(UpdateCharacteristicBody, body));
  }
}

@ApiTags('calibration')
@ApiBearerAuth()
@Controller('gauge-types')
export class GaugeTypesController {
  constructor(private readonly service: CalibrationService) {}

  @Get()
  @OrganisationScoped()
  @includeInactive()
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(GaugeType) })) })
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.service.listTypes(ctx, parse(GaugeTypeQuery, query)) };
  }

  @Post()
  @HttpCode(201)
  @OrganisationScoped('calibration.manage')
  @ApiBody({ schema: openApiSchema(CreateGaugeTypeBody) })
  @ApiCreatedResponse({ schema: openApiSchema(GaugeType) })
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createType(ctx, parse(CreateGaugeTypeBody, body));
  }

  @Patch(':id')
  @OrganisationScoped('calibration.manage')
  @ApiBody({ schema: openApiSchema(UpdateGaugeTypeBody) })
  @ApiOkResponse({ schema: openApiSchema(GaugeType) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateType(ctx, parse(Uuid, id), parse(UpdateGaugeTypeBody, body));
  }

  /** Template characteristics, copied onto new gauges of this type. */
  @Get(':id/characteristics')
  @OrganisationScoped()
  @includeInactive()
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Characteristic) })) })
  async listCharacteristics(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.service.listTypeCharacteristics(ctx, parse(Uuid, id), parse(CharacteristicQuery, query)) };
  }

  @Post(':id/characteristics')
  @HttpCode(201)
  @OrganisationScoped('calibration.manage')
  @ApiBody({ schema: openApiSchema(CreateCharacteristicBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Characteristic) })
  createCharacteristic(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createTypeCharacteristic(ctx, parse(Uuid, id), parse(CreateCharacteristicBody, body));
  }
}

@ApiTags('calibration')
@ApiBearerAuth()
@Controller('gauge-type-characteristics')
export class GaugeTypeCharacteristicsController {
  constructor(private readonly service: CalibrationService) {}

  @Patch(':id')
  @OrganisationScoped('calibration.manage')
  @ApiBody({ schema: openApiSchema(UpdateCharacteristicBody) })
  @ApiOkResponse({ schema: openApiSchema(Characteristic) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateTypeCharacteristic(ctx, parse(Uuid, id), parse(UpdateCharacteristicBody, body));
  }
}

@ApiTags('calibration')
@ApiBearerAuth()
@Controller('calibrations')
export class CalibrationsController {
  constructor(private readonly records: CalibrationRecordsService) {}

  @Get(':id')
  @OrganisationScoped('calibration.read', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(CalibrationDetail) })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.records.get(ctx, parse(Uuid, id));
  }

  /** Edit the record; readings are added or corrected per characteristic. */
  @Patch(':id')
  @OrganisationScoped('calibration.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(UpdateCalibrationBody) })
  @ApiOkResponse({ schema: openApiSchema(CalibrationDetail) })
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.records.update(ctx, parse(Uuid, id), parse(UpdateCalibrationBody, body));
  }

  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped('calibration.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ schema: openApiSchema(CalibrationDetail) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.records.remove(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped('calibration.record', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(CalibrationDetail) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.records.restore(ctx, parse(Uuid, id));
  }

  /** Raise a draft internal NC for a calibration found out of tolerance, linked to the record. */
  @Post(':id/raise-ncr')
  @HttpCode(201)
  @OrganisationScoped('ncr.create', SITE_SCOPED)
  @ApiCreatedResponse({ schema: openApiSchema(RaisedNcr) })
  raiseNcr(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.records.raiseNcr(ctx, parse(Uuid, id));
  }

  @Get(':id/attachments')
  @OrganisationScoped('calibration.read', SITE_SCOPED)
  @deletedQuery()
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Attachment) })) })
  async listAttachments(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() query: unknown) {
    return { data: await this.records.listAttachments(ctx, parse(Uuid, id), parse(DeletedQuery, query)) };
  }

  /** Record a certificate already uploaded to the calibration-files bucket at {organisationId}/calibration/{id}/… */
  @Post(':id/attachments')
  @HttpCode(201)
  @OrganisationScoped('calibration.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(CreateAttachmentBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Attachment) })
  createAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.records.createAttachment(ctx, parse(Uuid, id), parse(CreateAttachmentBody, body));
  }
}

@ApiTags('calibration')
@ApiBearerAuth()
@Controller('calibration-attachments')
export class CalibrationAttachmentsController {
  constructor(private readonly records: CalibrationRecordsService) {}

  @Post(':id/delete')
  @HttpCode(200)
  @OrganisationScoped('calibration.record', SITE_SCOPED)
  @ApiBody({ schema: openApiSchema(DeleteBody) })
  @ApiOkResponse({ schema: openApiSchema(Attachment) })
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.records.removeAttachment(ctx, parse(Uuid, id), parse(DeleteBody, body).reason);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @OrganisationScoped('calibration.record', SITE_SCOPED)
  @ApiOkResponse({ schema: openApiSchema(Attachment) })
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.records.restoreAttachment(ctx, parse(Uuid, id));
  }
}
