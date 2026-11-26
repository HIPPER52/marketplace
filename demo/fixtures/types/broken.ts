import type { components } from '../../../src/generated/api';

/**
 * The broken input for the type gate.
 *
 * It is deliberately the mistake the contract exists to prevent: money written
 * as a decimal string, the way a JSON body from another language would carry it. The
 * contract says `total_cents` is an integer count of minor units, `openapi-typescript`
 * turns that into `number`, and this assignment is therefore
 *
 *     TS2322: Type 'string' is not assignable to type 'number'.
 *
 * It is in this directory rather than in `src/` so that the repository stays green: the
 * root `tsconfig.json` includes `src`, `test` and `scripts` and never looks here. The
 * `tsconfig.json` beside this file extends the root one, so the gate compiles it with the
 * same options — `strict`, the same target, the same library — and the only difference
 * between the two runs of the gate is which file it is pointed at.
 */
export const order: components['schemas']['Order'] = {
    id: '00000000-0000-0000-0000-000000000000',
    user_id: 1,
    status: 'pending',
    currency: 'UAH',
    total_cents: '2600.00',
    created_at: '2026-11-26T00:00:00.000Z',
    items: [],
};
