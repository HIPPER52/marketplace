import { createHash } from 'node:crypto';
import type { Order } from './store.js';

interface Entry {
    requestHash: string;
    order: Order;
}

const entries = new Map<string, Entry>();

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

export function fingerprint(body: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(canonicalise(body)))
        .digest('hex');
}

export type Lookup =
    | { outcome: 'unseen' }
    | { outcome: 'replay'; order: Order }
    | { outcome: 'conflict' };

export function lookup(key: string, requestHash: string): Lookup {
    const entry = entries.get(key);

    if (entry === undefined) {
        return { outcome: 'unseen' };
    }

    return entry.requestHash === requestHash
        ? { outcome: 'replay', order: entry.order }
        : { outcome: 'conflict' };
}

export function remember(key: string, requestHash: string, order: Order): void {
    entries.set(key, { requestHash, order });
}
