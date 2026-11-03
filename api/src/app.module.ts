import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { NextFunction, Response } from 'express';
import { AuthGuard } from './auth/auth.guard';
import { JwtVerifier } from './auth/jwt-verifier.service';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ApiRequest, resolveCorrelationId } from './common/request-context';
import { ENV, Env } from './config/env';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { CustomersController, PartRevisionsController, PartsController, SuppliersController, UnitsController } from './master-data/master-data.controller';
import { MasterDataService } from './master-data/master-data.service';
import { MeController } from './me/me.controller';
import { MeService } from './me/me.service';
import { InvitationMailer } from './members/invitation-mailer.service';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { OrganisationsController } from './organisations/organisations.controller';
import { OrganisationsService } from './organisations/organisations.service';
import { DepartmentsController, SitesController } from './structure/structure.controller';
import { StructureService } from './structure/structure.service';
import { OrganisationGuard } from './tenancy/organisation.guard';

@Module({})
export class AppModule implements NestModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            genReqId: (req, res) => resolveCorrelationId(req as ApiRequest, res as Response),
            // Log an allowlist of request fields only: hosting platforms add their own credential
            // headers (e.g. Vercel's OIDC token), and Authorization/cookies must never be logged.
            serializers: {
              req: (req: { id: unknown; method: string; url: string; headers?: Record<string, unknown> }) => ({
                id: req.id,
                method: req.method,
                url: req.url,
                origin: req.headers?.origin,
                userAgent: req.headers?.['user-agent'],
              }),
            },
            customProps: (req) => ({ userId: (req as ApiRequest).user?.id, organisationId: (req as ApiRequest).organisationId }),
          },
        }),
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: env.RATE_LIMIT_PER_MINUTE }] }),
      ],
      controllers: [
        HealthController,
        MeController,
        OrganisationsController,
        SitesController,
        DepartmentsController,
        MembersController,
        UnitsController,
        CustomersController,
        SuppliersController,
        PartsController,
        PartRevisionsController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        DatabaseService,
        JwtVerifier,
        MeService,
        MasterDataService,
        OrganisationsService,
        StructureService,
        MembersService,
        InvitationMailer,
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        // Order matters: rate limit, then authenticate, then organisation scope/permission.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: OrganisationGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((req: ApiRequest, res: Response, next: NextFunction) => {
        resolveCorrelationId(req, res);
        next();
      })
      .forRoutes('*path');
  }
}
