import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { Authenticator, unauthenticated } from '../services/authenticator.service';
import type { Principal } from '../types/auth.types';

/**
 * Establishes **who**, and nothing else.
 *
 * Registered globally, so the default for every route is "closed" and a route nobody
 * thought about fails that way; `@Public()` is the opt-out. The verification itself lives
 * in Authenticator, because the WebSocket gateway asks the identical question.
 *
 * Every failure here is a 401. A missing, expired, forged or revoked token all mean "we
 * do not know who you are", and a client's SDK answers a 401 by refreshing. Answering 403
 * would tell it the question is settled and log the person out on a merely stale token —
 * which is the difference the lecture spends a slide on, and it is not a stylistic one.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly authenticator: Authenticator,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // A WebSocket handshake is authenticated by the gateway, which has a refusal
        // shape of its own; an HTTP guard has nothing to say about it.
        if (context.getType() !== 'http') {
            return true;
        }

        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (isPublic === true) {
            return true;
        }

        const request = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
        const token = this.authenticator.bearer(request.headers.authorization);

        if (token === null) {
            throw unauthenticated('No bearer token was presented.');
        }

        request.principal = await this.authenticator.identify(token);

        return true;
    }
}
