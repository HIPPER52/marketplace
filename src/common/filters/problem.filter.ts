import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, ProblemType, TITLE_BY_STATUS } from '../errors/problem.error';

@Catch()
export class ProblemFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost): void {
        const http = host.switchToHttp();
        const request = http.getRequest<Request>();
        const response = http.getResponse<Response>();

        const body =
            exception instanceof HttpException ? fromHttpException(exception) : describe(exception);

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
