import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { USER_ID_HEADER } from '../../orders/constants/realtime.constant';
import { SessionStore } from '../services/session-store.service';

/**
 * Touches the session on every request that says who it is.
 *
 * Middleware rather than something a handler calls, because "remember that this person was
 * here" is true of every route and nothing about it belongs to any one of them — the same
 * argument that put the realtime emit in a service rather than in a controller.
 *
 * It never fails a request. A session is a convenience the service offers; a person whose
 * last visit could not be recorded is still a person making a request right now.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
    constructor(private readonly sessions: SessionStore) {}

    async use(request: Request, _response: Response, next: NextFunction): Promise<void> {
        const claimed = request.headers[USER_ID_HEADER.toLowerCase()];

        if (typeof claimed === 'string' && claimed.trim() !== '') {
            await this.sessions.touch(claimed.trim());
        }

        next();
    }
}
