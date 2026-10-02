import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ApiErrorBody, ApiErrorCode } from '@workeasy/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

/** Single place where errors become HTTP responses. Internal details never reach the client. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = String(req.id);

    let status = 500;
    let code: ApiErrorCode = 'internal_error';
    let message = 'Something went wrong on our side. Please try again.';
    let fields: Record<string, string[]> | undefined;

    if (exception instanceof AppError) {
      ({ status, code, message, fields } = exception);
      for (const [k, v] of Object.entries(exception.headers ?? {})) reply.header(k, v);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      if (status === 404) {
        code = 'not_found';
        message = 'Not found';
      } else if (status === 413) {
        code = 'validation_failed';
        message = 'Request body is too large';
      } else if (status < 500) {
        code = 'validation_failed';
        message = 'The request could not be processed';
      }
    } else if (isFastifyClientError(exception)) {
      status = exception.statusCode;
      code = 'validation_failed';
      message = 'The request body is not valid JSON';
    }

    if (status >= 500) {
      this.logger.error({ requestId, err: exception }, exception instanceof Error ? exception.stack : String(exception));
    }

    const body: ApiErrorBody = { error: { code, message, ...(fields ? { fields } : {}), requestId } };
    void reply.status(status).header('cache-control', 'no-store').send(body);
  }
}

function isFastifyClientError(e: unknown): e is { statusCode: number } {
  const s = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' && s >= 400 && s < 500;
}
