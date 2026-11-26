import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, ProblemError, ProblemType, TITLE_BY_STATUS } from '../errors/problem.error';

@Catch()
export class ProblemFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost): void {
        const http = host.switchToHttp();
        const request = http.getRequest<Request>();
        const response = http.getResponse<Response>();

        const body =
            exception instanceof HttpException ? fromHttpException(exception) : describe(exception);

        if (exception instanceof ProblemError) {
            // The contract declares Retry-After on a 429 as required, and a header set
            // after the body has been written is a header nobody receives.
            response.set(exception.headers);
        }

        response
            .status(body.status)
            .type('application/problem+json')
            .json({
                ...body,
                instance: request.originalUrl,
            });
    }
}

function fromHttpException(exception: HttpException) {
    const status = exception.getStatus();
    const known = TITLE_BY_STATUS[status];

    return {
        type: known?.type ?? ProblemType.internal,
        title: known?.title ?? exception.name,
        status,
        detail: exception.message,
    };
}
