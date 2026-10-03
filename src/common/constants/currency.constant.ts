import type { Product } from '../types/api.types';

/**
 * The currencies openapi.yaml declares. `satisfies` is what keeps this honest: add a
 * currency to the contract without adding it here — or keep one here the contract has
 * dropped — and the build fails rather than the data drifting.
 */
export const Currency = {
    UAH: 'UAH',
    USD: 'USD',
    EUR: 'EUR',
} as const satisfies Record<string, Product['currency']>;

export type Currency = (typeof Currency)[keyof typeof Currency];

export const CURRENCIES = Object.values(Currency);
