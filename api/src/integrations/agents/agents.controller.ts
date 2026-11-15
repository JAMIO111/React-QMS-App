import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../../auth/auth.guard';
import { Ctx, RequestContext, resolveCorrelationId, type ApiRequest } from '../../common/request-context';
import { openApiSchema, parse, Uuid } from '../../common/validation';
import { ENV, Env } from '../../config/env';
import { clientAddress } from '../../security/client-address';
import { OrganisationScoped } from '../../tenancy/organisation.guard';
import { Agent, AgentCaller, AgentGuard } from './agent.guard';
import { AGENT_HEADERS, TOKEN_PATTERN } from './agent-signature';
import { ConnectionJobBody } from '../integrations.schemas';
import { AgentsService } from './agents.service';

const READ = 'integrations.read';
const MANAGE = 'integrations.manage';

const RenameBody = z.object({ name: z.string().trim().min(1).max(80), location: z.string().trim().max(200).nullable().optional() }).strict();
const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const PingBody = z.object({ idempotencyKey: z.string().min(8).max(120).optional() }).strict();
const RegistrationBody = z
  .object({
    name: z.string().trim().max(80).optional(),
    location: z.string().trim().max(200).nullable().optional(),
    expiresHours: z.number().int().min(1).max(168).optional(),
    replacesAgentId: Uuid.nullable().optional(),
  })
  .strict()
  .refine((b) => !!b.replacesAgentId || !!b.name, { message: 'Give the agent a name' });

const Key = z.string().regex(/^[A-Za-z0-9+/=]{40,400}$/, 'a public key in SPKI form, base64');
const Capabilities = z.record(z.string(), z.unknown()).refine((c) => JSON.stringify(c).length <= 4000, { message: 'Too large' });
const RegisterBody = z
  .object({
    token: z.string().trim().regex(TOKEN_PATTERN, 'a registration token from Fortress (FAGT-…)'),
    signingKey: Key,
    sealingKey: Key,
    version: z.string().trim().min(1).max(40),
    os: z.string().trim().min(1).max(120),
    machine: z.string().trim().min(1).max(120),
    capabilities: Capabilities.optional(),
  })
  .strict();
const HeartbeatBody = z
  .object({
    version: z.string().trim().max(40).nullable().optional(),
    os: z.string().trim().max(120).nullable().optional(),
    machine: z.string().trim().max(120).nullable().optional(),
    capabilities: Capabilities.nullable().optional(),
    uptimeSeconds: z.number().int().min(0).optional(),
  })
  .strict();
const ProgressBody = z.object({ progress: z.record(z.string(), z.unknown()) }).strict();
const CompleteBody = z.object({ result: z.unknown().optional() }).strict();
const FailBody = z
  .object({
    kind: z.enum(['auth', 'network', 'timeout', 'not_found', 'refused', 'invalid', 'internal']),
    message: z.string().trim().min(1).max(1000),
    transient: z.boolean().optional(),
  })
  .strict();
const RotateBody = z.object({ signingKey: Key, sealingKey: Key }).strict();

/** The bodies the agent sends, for the contract test against connector-agent/contract/messages. */
export const AGENT_MESSAGES = {
  register: RegisterBody,
  heartbeat: HeartbeatBody,
  progress: ProgressBody,
  'complete-ping': CompleteBody,
  fail: FailBody,
  rotate: RotateBody,
} as const;

const header = (req: Request, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Settings → Integrations → Connector agents (docs/connector-agent-plan.md AG1): the organisation's agents, one-time registrations, a ping to check an
 * agent answers, and revocation. Seeing them needs integrations.read; everything else integrations.manage (both need a Controller seat).
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class AgentsController {
  constructor(
    private readonly service: AgentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('agents')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The organisation\'s connector agents: online or not (a heartbeat in the last three minutes), version, machine, running jobs, last error' })
  list(@Ctx() ctx: RequestContext) {
    return this.service.list(ctx);
  }

  @Get('agents/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'One agent with its key fingerprints, latest jobs and events' })
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.get(ctx, parse(Uuid, id));
  }

  @Patch('agents/:id')
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RenameBody) })
  @ApiOkResponse({ description: 'Rename it or say where it is' })
  rename(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.rename(ctx, parse(Uuid, id), parse(RenameBody, body));
  }

  @Post('agents/:id/revoke')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ReasonBody) })
  @ApiOkResponse({ description: 'Revoke it for good: its key stops working on the next request and its waiting jobs are cancelled' })
  revoke(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.revoke(ctx, parse(Uuid, id), parse(ReasonBody, body).reason);
  }

  @Post('agents/:id/wake')
  @HttpCode(200)
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'Someone is looking at the agent: it is asked to poll every 15 seconds for the next ten minutes' })
  wake(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.wake(ctx, parse(Uuid, id));
  }

  @Post('agents/:id/ping')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(PingBody) })
  @ApiCreatedResponse({ description: 'A ping job: the agent answers with its version and clock when it next polls (within seconds while someone is looking)' })
  ping(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.ping(ctx, parse(Uuid, id), parse(PingBody, body ?? {}).idempotencyKey ?? null);
  }

  @Post('connections/:id/agent-jobs')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(ConnectionJobBody) })
  @ApiCreatedResponse({
    description: 'A database connection (AG2): ask its agent to test it, list schemas / tables and views / columns, or preview a table. A structured request, never SQL; follow it with GET agent-jobs/{id}.',
  })
  connectionJob(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.service.connectionJob(ctx, parse(Uuid, id), parse(ConnectionJobBody, body));
  }

  @Get('agent-jobs/:id')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'One job given to an agent: where it has got to and what came back' })
  job(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.job(ctx, parse(Uuid, id));
  }

  @Get('agent-registrations')
  @OrganisationScoped(READ)
  @ApiOkResponse({ description: 'The latest registrations: waiting, used, cancelled or expired (tokens are never shown again)' })
  registrations(@Ctx() ctx: RequestContext) {
    return this.service.registrations(ctx);
  }

  @Post('agent-registrations')
  @HttpCode(201)
  @OrganisationScoped(MANAGE)
  @ApiBody({ schema: openApiSchema(RegistrationBody) })
  @ApiCreatedResponse({ description: 'A one-time registration token (shown only in this answer), when it expires, the address the agent calls and where to download the installer' })
  createRegistration(@Ctx() ctx: RequestContext, @Body() body: unknown, @Req() req: Request) {
    const apiUrl = this.env.AGENT_API_URL ?? `${req.protocol}://${req.get('host')}/api/v1`;
    return this.service.createRegistration(ctx, parse(RegistrationBody, body), apiUrl, this.env.AGENT_DOWNLOAD_URL ?? null);
  }

  @Post('agent-registrations/:id/cancel')
  @HttpCode(200)
  @OrganisationScoped(MANAGE)
  @ApiOkResponse({ description: 'Cancel a registration that has not been used' })
  cancelRegistration(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.service.cancelRegistration(ctx, parse(Uuid, id));
  }
}

/**
 * The Connector Agent's own API (docs/connector-agent-plan.md §6). No person's token: every request is signed with the agent's key (AgentGuard);
 * registration is signed with the key being registered and carries the one-time token. The agent only ever calls out; Fortress never calls in.
 */
@ApiTags('connector agent')
@Controller('integrations/agent')
@Public()
@SkipThrottle()
export class AgentApiController {
  constructor(private readonly service: AgentsService) {}

  @Post('register')
  @HttpCode(201)
  @ApiBody({ schema: openApiSchema(RegisterBody) })
  @ApiCreatedResponse({ description: 'The agent\'s id and organisation. Signed with the key being registered; the token is single use.' })
  register(@Req() req: RawBodyRequest<Request>, @Body() body: unknown) {
    return this.service.register(
      parse(RegisterBody, body),
      {
        method: req.method,
        path: req.originalUrl,
        rawBody: req.rawBody,
        timestamp: header(req, AGENT_HEADERS.timestamp),
        nonce: header(req, AGENT_HEADERS.nonce),
        signature: header(req, AGENT_HEADERS.signature),
      },
      clientAddress(req.ip),
      resolveCorrelationId(req as unknown as ApiRequest),
    );
  }

  @Post('heartbeat')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  @ApiBody({ schema: openApiSchema(HeartbeatBody) })
  @ApiOkResponse({ description: 'Whether jobs are waiting and how often to poll (15 seconds while someone is waiting, else 60)' })
  heartbeat(@Agent() agent: AgentCaller, @Body() body: unknown) {
    return this.service.heartbeat(agent, parse(HeartbeatBody, body ?? {}));
  }

  @Post('jobs/next')
  @UseGuards(AgentGuard)
  @ApiOkResponse({ description: 'The next job, leased to this agent for five minutes (progress reports extend it); 204 when there is none' })
  async next(@Agent() agent: AgentCaller, @Res({ passthrough: true }) res: Response) {
    const job = await this.service.nextJob(agent);
    if (!job) {
      res.status(204);
      return undefined;
    }
    res.status(200);
    return job;
  }

  @Post('jobs/:id/ack')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  @ApiOkResponse({ description: 'The agent has started the job' })
  ack(@Agent() agent: AgentCaller, @Param('id') id: string) {
    return this.service.report(agent, parse(Uuid, id), 'ack', {});
  }

  @Post('jobs/:id/progress')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  @ApiBody({ schema: openApiSchema(ProgressBody) })
  @ApiOkResponse({ description: 'Progress on a running job; extends its lease. The answer says when the job has been cancelled.' })
  progress(@Agent() agent: AgentCaller, @Param('id') id: string, @Body() body: unknown) {
    return this.service.report(agent, parse(Uuid, id), 'progress', parse(ProgressBody, body));
  }

  @Post('jobs/:id/complete')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  @ApiBody({ schema: openApiSchema(CompleteBody) })
  @ApiOkResponse({ description: 'The job is done, with its result. Repeating it changes nothing.' })
  complete(@Agent() agent: AgentCaller, @Param('id') id: string, @Body() body: unknown) {
    return this.service.report(agent, parse(Uuid, id), 'complete', parse(CompleteBody, body ?? {}));
  }

  @Post('jobs/:id/fail')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  @ApiBody({ schema: openApiSchema(FailBody) })
  @ApiOkResponse({ description: 'The job could not be done. A transient failure is tried again while attempts remain.' })
  fail(@Agent() agent: AgentCaller, @Param('id') id: string, @Body() body: unknown) {
    return this.service.report(agent, parse(Uuid, id), 'fail', parse(FailBody, body));
  }

  @Post('keys/rotate')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  @ApiBody({ schema: openApiSchema(RotateBody) })
  @ApiOkResponse({ description: 'Replace the agent\'s keys; signed with the current key. The next request must be signed with the new one.' })
  rotate(@Agent() agent: AgentCaller, @Body() body: unknown) {
    return this.service.rotateKey(agent, parse(RotateBody, body));
  }

  @Post('deregister')
  @HttpCode(200)
  @UseGuards(AgentGuard)
  @ApiOkResponse({ description: 'The agent is being uninstalled: it revokes itself' })
  deregister(@Agent() agent: AgentCaller) {
    return this.service.deregister(agent);
  }
}
