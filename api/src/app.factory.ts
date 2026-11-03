import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { corsOrigins, Env } from './config/env';

export const API_PREFIX = 'api/v1';

/** Builds the configured application (used by main.ts and the e2e tests). */
export async function createApp(env: Env): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: corsOrigins(env),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Organisation-Id', 'X-Correlation-Id', 'X-Change-Reason', 'Idempotency-Key'],
    exposedHeaders: ['X-Correlation-Id'],
    maxAge: 600,
  });
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('QMS Platform API')
      .setDescription(
        'Versioned API for the manufacturing QMS. Authenticate with a Supabase access token ' +
          '(Authorization: Bearer). Organisation-scoped routes need X-Organisation-Id. Errors use ' +
          '{ error: { code, message, details?, correlationId } }.',
      )
      .setVersion('1')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, { jsonDocumentUrl: `${API_PREFIX}/openapi.json` });

  return app;
}
