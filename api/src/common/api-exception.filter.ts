import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from './api-error';
import { apiErrorFromDatabase } from './database-errors';
import { ApiRequest, resolveCorrelationId } from './request-context';

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable',
  429: 'rate_limited',
};

/** Renders every error as { error: { code, message, details?, correlationId } } and never leaks internals. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    const res = http.getResponse<Response>();
    const correlationId = resolveCorrelationId(req, res);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'An unexpected error occurred';
    let details: unknown;

    const mapped = exception instanceof HttpException ? undefined : apiErrorFromDatabase(exception);
    if (mapped) exception = mapped;

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODES[status] ?? (status >= 500 ? 'internal_error' : 'error');
      const body = exception.getResponse();
      message =
        typeof body === 'object' && body && 'message' in body && typeof body.message === 'string'
          ? body.message
          : exception.message;
      if (status === HttpStatus.TOO_MANY_REQUESTS) message = 'Too many requests, please slow down';
    } else if ((exception as { type?: string } | null)?.type === 'entity.too.large') {
      // The body parser refused a request over the size limit (before any route ran).
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      code = 'payload_too_large';
      message = 'The request is too large';
    } else {
      this.logger.error({ err: exception, correlationId }, 'Unhandled error');
    }

    res.status(status).json({
      error: { code, message, ...(details !== undefined ? { details } : {}), correlationId },
    });
  }
}
