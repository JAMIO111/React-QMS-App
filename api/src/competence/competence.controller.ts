import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequestContext } from '../common/request-context';
import { openApiSchema, parse, Uuid } from '../common/validation';
import { OrganisationScoped } from '../tenancy/organisation.guard';
import {
  AddAttendeeBody, CreateSessionBody, RecordAttendeesBody, SessionAttachmentBody, SessionListQuery, UpdateSessionBody, AllQuery, AssessBody, AssignPositionBody, EndPositionBody, MatrixQuery, Category, CreateCategoryBody, CreatePositionBody, CreateSkillBody, Position, ReasonBody, SetPositionSkillsBody, Skill, SkillListQuery, UpdateCategoryBody,
  UpdatePositionBody, UpdateSkillBody,
} from './competence.schemas';
import { CompetencePeopleService } from './competence-people.service';
import { CompetenceTrainingService } from './competence-training.service';
import { CompetenceService } from './competence.service';

const READ = 'competence.read';
const MANAGE = 'competence.manage';

/** Competence (CO1): categories, skills and positions with what each position requires. Seeing everything is `competence.read` (Controller-seat holders get it too). */
@ApiTags('competence')
@ApiBearerAuth()
@Controller('competence')
export class CompetenceController {
  constructor(
    private readonly service: CompetenceService,
    private readonly people: CompetencePeopleService,
    private readonly training: CompetenceTrainingService,
  ) {}

  // ---- categories ----------------------------------------------------------------------------------

  @Get('categories')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] } })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Category) })) })
  categories(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.categories(ctx, parse(AllQuery, query));
  }

  @Post('categories')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateCategoryBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Category) })
  createCategory(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createCategory(ctx, parse(CreateCategoryBody, body));
  }

  @Patch('categories/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateCategoryBody) })
  @ApiOkResponse({ description: 'Renames, describes, reorders or switches a category off (nothing is deleted)', schema: openApiSchema(Category) })
  updateCategory(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateCategory(ctx, parse(Uuid, id), parse(UpdateCategoryBody, body));
  }

  // ---- skills --------------------------------------------------------------------------------------

  @Get('skills')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include retired skills' })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Skill) })) })
  skills(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.skills(ctx, parse(SkillListQuery, query));
  }

  @Post('skills')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreateSkillBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Skill) })
  createSkill(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createSkill(ctx, parse(CreateSkillBody, body));
  }

  @Patch('skills/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdateSkillBody) })
  @ApiOkResponse({ description: 'Edits a skill. Its code never changes.', schema: openApiSchema(Skill) })
  updateSkill(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updateSkill(ctx, parse(Uuid, id), parse(UpdateSkillBody, body));
  }

  @Post('skills/:id/retire')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Retires a skill with a reason; refused while an active position requires it', schema: openApiSchema(Skill) })
  retireSkill(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retireSkill(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post('skills/:id/reactivate')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(Skill) })
  reactivateSkill(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reactivateSkill(ctx, parse(Uuid, id));
  }

  // ---- positions -----------------------------------------------------------------------------------

  @Get('positions')
  @OrganisationScoped(READ)
  @ApiQuery({ name: 'all', required: false, schema: { type: 'string', enum: ['true', 'false'] }, description: 'Include retired positions' })
  @ApiOkResponse({ schema: openApiSchema(z.object({ data: z.array(Position) })) })
  positions(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.service.positions(ctx, parse(AllQuery, query));
  }

  @Post('positions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(CreatePositionBody) })
  @ApiCreatedResponse({ schema: openApiSchema(Position) })
  createPosition(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.service.createPosition(ctx, parse(CreatePositionBody, body));
  }

  @Get('positions/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ schema: openApiSchema(Position) })
  position(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.position(ctx, parse(Uuid, id));
  }

  @Patch('positions/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(UpdatePositionBody) })
  @ApiOkResponse({ schema: openApiSchema(Position) })
  updatePosition(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.updatePosition(ctx, parse(Uuid, id), parse(UpdatePositionBody, body));
  }

  @Put('positions/:id/skills')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(SetPositionSkillsBody) })
  @ApiOkResponse({ description: 'Replaces what the position requires as a whole', schema: openApiSchema(Position) })
  setPositionSkills(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.setPositionSkills(ctx, parse(Uuid, id), parse(SetPositionSkillsBody, body));
  }

  @Post('positions/:id/retire')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ schema: openApiSchema(Position) })
  retirePosition(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.retirePosition(ctx, parse(Uuid, id), parse(ReasonBody, body));
  }

  @Post('positions/:id/reactivate')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ schema: openApiSchema(Position) })
  reactivatePosition(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.reactivatePosition(ctx, parse(Uuid, id));
  }

  // ---- people: the matrix, a person's standing, positions held, assessments (CO2) -------------------

  @Get('matrix')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Employees by skills: level, what their positions require, the gap and the expiry, worked out on read' })
  matrix(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.people.matrix(ctx, parse(MatrixQuery, query));
  }

  @Get('me')
  @OrganisationScoped()
  @ApiOkResponse({ description: "The caller's own competence record, when their sign-in is linked to an employee (`linked: false` otherwise)" })
  me(@Ctx() ctx: RequestContext) {
    return this.people.me(ctx);
  }

  @Get('people/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: "One person's positions, skills with level, requirement, gap, expiry and assessment history" })
  person(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.people.person(ctx, parse(Uuid, id));
  }

  @Post('people/:id/positions')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(AssignPositionBody) })
  @ApiCreatedResponse({ description: 'Gives the person a position from a date; answers with their profile' })
  assignPosition(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.people.assignPosition(ctx, parse(Uuid, id), parse(AssignPositionBody, body));
  }

  @Post('employee-positions/:id/end')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(EndPositionBody) })
  @ApiOkResponse({ description: 'Ends a position held (kept for history); answers with the profile' })
  endPosition(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.people.endPosition(ctx, parse(Uuid, id), parse(EndPositionBody, body ?? {}));
  }

  @Post('people/:id/assessments')
  @HttpCode(201)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(AssessBody) })
  @ApiCreatedResponse({ description: 'Records an assessment (never your own; level 4 needs competence.manage); answers with the profile' })
  assess(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.people.assess(ctx, parse(Uuid, id), parse(AssessBody, body));
  }

  // ---- training sessions with attendee lists (CO3) ---------------------------------------------------
  // Reading needs only membership: the database shows managers and readers everything and anyone else only the sessions they are on.

  @Get('training-sessions')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'Training sessions, page-based (`q`, `status`, `skillId`, `employeeId`, `from`, `to`, `sort`, `order`, `page`, `pageSize`)' })
  sessions(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.training.list(ctx, parse(SessionListQuery, query));
  }

  @Post('training-sessions')
  @HttpCode(201)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(CreateSessionBody) })
  @ApiCreatedResponse({ description: 'Creates a session with its attendee list' })
  createSession(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.training.create(ctx, parse(CreateSessionBody, body));
  }

  @Get('training-sessions/:id')
  @OrganisationScoped()
  @ApiOkResponse({ description: 'A session with its skills, attendees (each with their own completed date) and files' })
  session(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.training.get(ctx, parse(Uuid, id));
  }

  @Patch('training-sessions/:id')
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(UpdateSessionBody) })
  @ApiOkResponse({ description: 'Edits an open session (skills are replaced as a whole)' })
  updateSession(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.update(ctx, parse(Uuid, id), parse(UpdateSessionBody, body));
  }

  @Post('training-sessions/:id/attendees')
  @HttpCode(201)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(AddAttendeeBody) })
  @ApiCreatedResponse({ description: 'Adds a person to an open session' })
  addAttendee(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.addAttendee(ctx, parse(Uuid, id), parse(AddAttendeeBody, body));
  }

  @Post('training-sessions/:id/record')
  @HttpCode(200)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(RecordAttendeesBody) })
  @ApiOkResponse({ description: 'Records completed / failed / absent for several attendees on one day; repeat on another day for others' })
  recordAttendees(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.record(ctx, parse(Uuid, id), parse(RecordAttendeesBody, body));
  }

  @Post('session-attendees/:id/remove')
  @HttpCode(200)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Removes someone still enrolled (reason kept)' })
  removeAttendee(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.removeAttendee(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('session-attendees/:id/void')
  @HttpCode(200)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Voids a recorded result (reason kept); add the person again while the session is open' })
  voidAttendee(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.voidAttendee(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('training-sessions/:id/close')
  @HttpCode(200)
  @OrganisationScoped('competence.assess')
  @ApiOkResponse({ description: 'Closes a session once nobody is still enrolled' })
  closeSession(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.training.close(ctx, parse(Uuid, id));
  }

  @Post('training-sessions/:id/reopen')
  @HttpCode(200)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Reopens a closed session (reason kept)' })
  reopenSession(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.reopen(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('training-sessions/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Cancels an open session with no recorded result (reason kept)' })
  cancelSession(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.cancel(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('training-sessions/:id/attachments')
  @HttpCode(201)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(SessionAttachmentBody) })
  @ApiCreatedResponse({ description: 'Records a file already uploaded to competence-files, on the session or (attendeeId) on one attendee' })
  addAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.addAttachment(ctx, parse(Uuid, id), parse(SessionAttachmentBody, body));
  }

  @Post('competence-attachments/:id/delete')
  @HttpCode(200)
  @OrganisationScoped('competence.assess')
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Marks a file removed (never deleted)' })
  removeAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.training.removeAttachment(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('competence-attachments/:id/restore')
  @HttpCode(200)
  @OrganisationScoped('competence.assess')
  @ApiOkResponse({ description: 'Brings a removed file back' })
  restoreAttachment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.training.restoreAttachment(ctx, parse(Uuid, id));
  }
}
