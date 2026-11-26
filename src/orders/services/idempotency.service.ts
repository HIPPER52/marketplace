import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import {
    IdempotencyKeysRepository,
    type KeyClaim,
} from '../repositories/idempotency-keys.repository';

function canonicalise(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalise);
    }

    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, canonicalise(nested)]),
        );
    }

    return value;
}

/**
 * `Idempotency-Key`, backed by the database rather than by a Map.
 *
 * The Map worked for as long as there was one process that never restarted — which is to
 * say it was the anti-pattern this subject keeps naming: a deduplication set in memory
 * does not exist between two replicas and does not survive a deploy, and those are the two
 * moments a client is most likely to retry.
 *
 * The hash is of the **canonicalised** body, so a client that reorders JSON keys still
 * gets its replay. It is not the identity of the request: the key is, and the hash only
 * catches one key being reused for a different intent.
 */
@Injectable()
export class IdempotencyRegistry {
    private readonly keys: IdempotencyKeysRepository;

    constructor(@Inject(DATA_SOURCE) dataSource: DataSource) {
        this.keys = new IdempotencyKeysRepository(dataSource);
    }

    fingerprint(body: unknown): string {
        return createHash('sha256')
            .update(JSON.stringify(canonicalise(body)))
            .digest('hex');
    }

    claim(key: string, requestHash: string): Promise<KeyClaim> {
        return this.keys.claim(key, requestHash);
    }

    release(key: string): Promise<void> {
        return this.keys.release(key);
    }

    /** The collaborator CheckoutService completes the reservation through. */
    get completer(): IdempotencyKeysRepository {
        return this.keys;
    }
}
