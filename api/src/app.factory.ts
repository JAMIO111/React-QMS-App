import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { corsOrigins, docsEnabled, Env, trustProxyHops } from './config/env';

export const API_PREFIX = 'api/v1';

/** Builds the configured application (used by the e2e tests; main.ts does the same steps). */
export async function createApp(env: Env): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), { bufferLogs: true, rawBody: true });
  return configureApp(app, env);
}

/** Applies logging, prefix, CORS and OpenAPI to a created application. */
export function configureApp(app: NestExpressApplication, env: Env): INestApplication {
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  // Behind a proxy (Vercel) the client address comes from X-Forwarded-For; without this every caller shared the proxy's address in the rate limit.
  const hops = trustProxyHops(env);
  if (hops > 0) app.set('trust proxy', hops);
  // Security headers. The reference page (when it is on) needs inline scripts, so the content policy is left to it; the API itself answers JSON only.
  app.use(helmet({ contentSecurityPolicy: docsEnabled(env) ? false : undefined, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({
    origin: corsOrigins(env),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Organisation-Id', 'X-Correlation-Id', 'X-Change-Reason', 'X-Time-Zone', 'Idempotency-Key'],
    exposedHeaders: ['X-Correlation-Id'],
    maxAge: 600,
  });
  app.enableShutdownHooks();

  if (docsEnabled(env)) {
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
  }

  return app;
}
