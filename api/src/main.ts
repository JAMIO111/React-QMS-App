import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app.factory';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

// Entry file for `npm run start` and for Vercel, which requires the entry to import NestJS directly.
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), { bufferLogs: true, rawBody: true });
  configureApp(app, env);
  await app.listen(env.PORT);
}

bootstrap().catch((error: unknown) => {
  // Configuration errors are printed without secrets (see loadEnv).
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
