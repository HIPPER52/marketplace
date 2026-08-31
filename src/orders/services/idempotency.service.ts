import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Order } from '../../common/types/api.types';
import type { Lookup } from '../types/idempotency.types';

interface Entry {
    requestHash: string;
    order: Order;
}

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

@Injectable()
export class IdempotencyRegistry {
    private readonly entries = new Map<string, Entry>();

    fingerprint(body: unknown): string {
        return createHash('sha256')
            .update(JSON.stringify(canonicalise(body)))
            .digest('hex');
    }

    lookup(key: string, requestHash: string): Lookup {
        const entry = this.entries.get(key);

        if (entry === undefined) {
            return { outcome: 'unseen' };
        }

        return entry.requestHash === requestHash
            ? { outcome: 'replay', order: entry.order }
            : { outcome: 'conflict' };
    }

    remember(key: string, requestHash: string, order: Order): void {
        this.entries.set(key, { requestHash, order });
    }
}
