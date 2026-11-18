import 'dotenv/config';
import { applyStorageEnvOverlay } from './config/storage-env-overlay';
applyStorageEnvOverlay();
import { webcrypto } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { resolveCorsOrigin } from './config/cors.util';
import { AppLogger } from './logging/app-logger';

// Polyfill para crypto global em Node.js
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as any;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: new AppLogger(),
  });
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '10mb' });

  app.enableCors({
    origin: resolveCorsOrigin(process.env.CORS_ALLOWED_ORIGINS),
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Timezone', 'Timezone'],
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('Jardim das Conquistas API')
    .setDescription(
      'API do backend do Jardim das Conquistas — gerenciamento de metas, mundos, árvores e integração com Telegram/WhatsApp.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
}
bootstrap();
