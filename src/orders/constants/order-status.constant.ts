import type { Order } from '../../common/types/api.types';

/**
 * The order lifecycle openapi.yaml declares. Checked against the generated contract type
 * for the same reason Currency is — see src/common/constants/currency.constant.ts.
 */
export const OrderStatus = {
    Pending: 'pending',
    Paid: 'paid',
    Shipped: 'shipped',
    Cancelled: 'cancelled',
} as const satisfies Record<string, Order['status']>;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUSES = Object.values(OrderStatus);
