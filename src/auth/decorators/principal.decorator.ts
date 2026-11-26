import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from '../types/auth.types';

/**
 * The authenticated caller, as the guard established them.
 *
 * Handlers take this instead of reading a header, so no route can accidentally trust
 * something a client wrote — which is exactly what `X-User-Id` was until this assignment.
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<Request & { principal?: Principal }>();

    return request.principal;
});
