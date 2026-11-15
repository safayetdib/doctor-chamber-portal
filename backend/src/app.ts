import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import type { ApiError, HealthResponse } from '@practice/contracts';
import { IdentityError } from './identity/security.js';

interface AppDependencies {
  logger: Logger;
  checkReady: () => Promise<void>;
  apiRouter?: express.Router;
}

export function createApp({ logger, checkReady, apiRouter }: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(pinoHttp({
    logger,
    genReqId: (_request, response) => {
      const id = randomUUID();
      response.setHeader('X-Request-Id', id);
      return id;
    },
    // No URLs/query strings, headers or bodies: activation/OTP endpoints may
    // carry secrets. Route-level audit events can add safe identifiers later.
    serializers: {
      req: (request: { id: string; method: string }) => ({ id: request.id, method: request.method }),
      res: (response: { statusCode: number }) => ({ statusCode: response.statusCode })
    }
  }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/v1/health/live', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ status: 'ok', service: 'practice-api' } satisfies HealthResponse);
  });

  app.get('/api/v1/health/ready', async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      await checkReady();
      response.json({ status: 'ready', service: 'practice-api' } satisfies HealthResponse);
    } catch {
      response.status(503).json({ status: 'not_ready', service: 'practice-api' } satisfies HealthResponse);
    }
  });

  if (apiRouter) app.use('/api/v1', apiRouter);

  app.use((request, response) => {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Endpoint not found.', requestId: String(request.id) }
    } satisfies ApiError);
  });

  const handleError: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (error instanceof IdentityError) {
      response.status(error.status).json({
        error: {
          code: error.code, message: error.message, requestId: String(request.id),
          ...(error.details && { details: error.details })
        }
      } satisfies ApiError);
      return;
    }
    const bodyError = error as { type?: string };
    const malformed = bodyError?.type === 'entity.parse.failed';
    const oversized = bodyError?.type === 'entity.too.large';
    const status = malformed ? 400 : oversized ? 413 : 500;
    const code = malformed ? 'INVALID_JSON' : oversized ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR';
    if (status === 500) request.log.error({ code }, 'Request failed');
    response.status(status).json({
      error: {
        code,
        message: malformed ? 'Request body must be valid JSON.' : oversized ? 'Request body is too large.' : 'Unexpected server error.',
        requestId: String(request.id)
      }
    } satisfies ApiError);
  };
  app.use(handleError);
  return app;
}
