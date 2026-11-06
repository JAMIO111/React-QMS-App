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
import { CalibrationDashboardController, CalibrationDashboardService } from './calibration/calibration-dashboard';
import {
  CalibrationAttachmentsController,
  CalibrationsController,
  GaugeCharacteristicsController,
  GaugesController,
  GaugeTypeCharacteristicsController,
  GaugeTypesController,
} from './calibration/calibration.controller';
import { CalibrationRecordsService } from './calibration/calibration-records.service';
import { CalibrationService } from './calibration/calibration.service';
import { HealthController } from './health/health.controller';
import { CustomersController, PartCustomersController, PartRevisionsController, PartsController, SuppliersController, UnitsController } from './master-data/master-data.controller';
import { MasterDataService } from './master-data/master-data.service';
import { EmployeesController, NcrClassificationsController, NcrController } from './ncr/ncr.controller';
import { NcrService } from './ncr/ncr.service';
import { NcrAttachmentsController, NcrChildRecordsController, NcrCostsController } from './ncr/ncr-records.controller';
import { NcrRecordsService } from './ncr/ncr-records.service';
import { NcrDashboardController, NcrDashboardService } from './ncr/ncr-dashboard';
import { MeController } from './me/me.controller';
import { MeService } from './me/me.service';
import { InvitationMailer } from './members/invitation-mailer.service';
import { MembersController } from './members/members.controller';
import { MembersService } from './members/members.service';
import { OrganisationsController } from './organisations/organisations.controller';
import { OrganisationsService } from './organisations/organisations.service';
import { DepartmentsController, SitesController } from './structure/structure.controller';
import { StructureService } from './structure/structure.service';
import {
  ControlPlanContentController,
  ControlPlanRevisionsController,
  ControlPlansController,
  MachinesController,
  PartFamiliesController,
  SpecValuesController,
} from './process-control/process-control.controller';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { CharacteristicTemplatesController } from './process-control/characteristic-templates.controller';
import { CharacteristicTemplatesService } from './process-control/characteristic-templates.service';
import { ProcessControlService } from './process-control/process-control.service';
import { GaugeUsageController, InspectionMeasurementsController, InspectionsController, NcrInspectionSourceController } from './inspection/inspection.controller';
import { InspectionService } from './inspection/inspection.service';
import { ProcessControlDashboardController, ProcessControlDashboardService } from './process-control/process-control-dashboard';
import { QualityAlertAttachmentsController, QualityAlertsController } from './documentation/documentation.controller';
import { DocumentationService } from './documentation/documentation.service';
import { SpcController } from './spc/spc.controller';
import { SpcService } from './spc/spc.service';
import { ControlPlanContentService } from './process-control/control-plan-content.service';
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
        PartCustomersController,
        NcrController,
        NcrChildRecordsController,
        NcrCostsController,
        NcrAttachmentsController,
        NcrDashboardController,
        NcrClassificationsController,
        EmployeesController,
        GaugesController,
        GaugeCharacteristicsController,
        GaugeTypesController,
        GaugeTypeCharacteristicsController,
        CalibrationsController,
        CalibrationAttachmentsController,
        CalibrationDashboardController,
        MachinesController,
        PartFamiliesController,
        SpecValuesController,
        ControlPlansController,
        ControlPlanRevisionsController,
        ControlPlanContentController,
        CharacteristicTemplatesController,
        BillingController,
        NotificationsController,
        InspectionsController,
        InspectionMeasurementsController,
        NcrInspectionSourceController,
        SpcController,
        QualityAlertsController,
        QualityAlertAttachmentsController,
        ProcessControlDashboardController,
        GaugeUsageController,
      ],
      providers: [
        { provide: ENV, useValue: env },
        DatabaseService,
        JwtVerifier,
        MeService,
        MasterDataService,
        NcrService,
        NcrRecordsService,
        NcrDashboardService,
        CalibrationService,
        CalibrationRecordsService,
        CalibrationDashboardService,
        ProcessControlService,
        ControlPlanContentService,
        CharacteristicTemplatesService,
        BillingService,
        NotificationsService,
        InspectionService,
        SpcService,
        DocumentationService,
        ProcessControlDashboardService,
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
