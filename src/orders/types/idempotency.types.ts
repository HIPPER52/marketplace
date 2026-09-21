import type { Order } from '../../common/types/api.types';

export type Lookup =
    | { outcome: 'unseen' }
    | { outcome: 'replay'; order: Order }
    | { outcome: 'conflict' };
