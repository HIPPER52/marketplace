import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/schemas/env.schema';

/**
 * Who the caller says they are — and whether this environment is willing to take their
 * word for it.
 *
 * There is no authentication in this project yet. Realtime needs an identity anyway: an
 * order's events belong to its buyer, and the check is worth writing before the thing it
 * checks is trustworthy. So the identity is a **claim** — `auth: { userId }` in the
 * socket.io handshake, `X-User-Id` over HTTP — and a claim is exactly as strong as the
 * client's honesty, which is to say not at all. Anyone can type somebody else's id.
 *
 * That is fine while it cannot reach anyone. It stops being fine the moment it ships, so
 * it does not ship: **outside development and test, no claim is accepted and both
 * transports refuse everyone.** Realtime notifications are simply not available until
 * there is a way to prove who is asking. A feature that is missing is an honest state; a
 * feature that looks like it enforces ownership and does not is a lie told to whoever
 * reads the code next.
 *
 * #24 replaces `resolve` with a verified token. Nothing else moves: both call sites ask
 * the same question and handle the same `null`.
 */
@Injectable()
export class ClaimedIdentityService {
    private readonly logger = new Logger(ClaimedIdentityService.name);
    private readonly trusted: boolean;

    constructor(config: ConfigService<Env, true>) {
        this.trusted = config.get('NODE_ENV', { infer: true }) !== 'production';

        if (!this.trusted) {
            this.logger.warn(
                'Realtime is closed: an unsigned identity claim is not accepted outside ' +
                    'development. Every join and every event stream will be refused until ' +
                    'authentication exists.',
            );
        }
    }

    /** False when this environment refuses claims outright — the caller says so plainly. */
    get accepted(): boolean {
        return this.trusted;
    }

    /**
     * The claimed id, or null when there is none to use. A number is accepted because
     * `users.id` is a bigint and a JSON client sends it unquoted more often than not.
     */
    resolve(claim: unknown): string | null {
        if (!this.trusted) {
            return null;
        }

        if (typeof claim === 'string' && claim.trim() !== '') {
            return claim.trim();
        }

        if (typeof claim === 'number' && Number.isInteger(claim)) {
            return String(claim);
        }

        return null;
    }

    /** Why a caller was refused, in words that distinguish the two reasons. */
    refusal(): string {
        return this.trusted
            ? 'Say who is asking.'
            : 'Realtime is unavailable in this environment: an unsigned identity claim is ' +
                  'not accepted, and authentication does not exist yet.';
    }
}
