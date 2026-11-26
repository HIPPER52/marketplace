import type { Order as ApiOrder, OrderItem as ApiOrderItem } from '../../common/types/api.types';
import type { Order } from '../entities/order.entity';
import type { OrderItem } from '../entities/order-item.entity';

export function toApiOrder(order: Order): ApiOrder {
    return {
        id: order.id,
        status: order.status,
        items: order.items.map(toApiOrderItem),
        total_cents: order.totalCents,
        currency: order.currency,
        created_at: order.createdAt.toISOString(),
    };
}

function toApiOrderItem(item: OrderItem): ApiOrderItem {
    return {
        product_id: item.productId,
        quantity: item.quantity,
        unit_price_cents: item.unitPriceCents,
        subtotal_cents: item.subtotalCents,
    };
}
