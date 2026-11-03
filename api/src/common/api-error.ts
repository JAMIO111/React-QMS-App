import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error with a stable machine-readable code. Rendered by ApiExceptionFilter as
 * { "error": { "code", "message", "details", "correlationId" } }.
 */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message, status);
  }

  static badRequest(code: string, message: string, details?: unknown) {
    return new ApiError(HttpStatus.BAD_REQUEST, code, message, details);
  }
  static unauthenticated(message = 'Authentication required') {
    return new ApiError(HttpStatus.UNAUTHORIZED, 'unauthenticated', message);
  }
  static forbidden(message = 'You do not have permission to do this', details?: unknown) {
    return new ApiError(HttpStatus.FORBIDDEN, 'forbidden', message, details);
  }
  static notFound(code = 'not_found', message = 'Not found') {
    return new ApiError(HttpStatus.NOT_FOUND, code, message);
  }
  static unavailable(message = 'Service unavailable') {
    return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'unavailable', message);
  }
}
