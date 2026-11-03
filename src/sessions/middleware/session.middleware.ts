import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { BEARER_PREFIX } from '../../auth/constants/auth.constant';
import { TokenSigner } from '../../auth/services/token-signer.service';
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
    constructor(
        private readonly sessions: SessionStore,
        private readonly signer: TokenSigner,
    ) {}

    /**
     * The subject of a validly signed token, and nothing else.
     *
     * Until #24 this took `X-User-Id` at its word, which meant anybody could write to
     * anybody's session key. Signature only — no denylist, no `SELECT` — because this is
     * a "last seen" note rather than a decision, it runs ahead of the guard on every
     * request, and a token that was revoked a minute ago still names its owner.
     */
    async use(request: Request, _response: Response, next: NextFunction): Promise<void> {
        const header = request.headers.authorization;

        if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
            const subject = this.signer.subjectOf(header.slice(BEARER_PREFIX.length));

            if (subject !== null) {
                await this.sessions.touch(subject);
            }
        }

        next();
    }
}
