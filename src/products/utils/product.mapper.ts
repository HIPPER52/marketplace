import type {
    Product as ApiProduct,
    ProductCard as ApiProductCard,
} from '../../common/types/api.types';
import type { Product } from '../entities/product.entity';
import type { ProductCardRow } from '../repositories/products.repository';

/**
 * Entity to contract. The two are deliberately not the same object: `description` and
 * `search_vector` are storage, `created_at` is not part of components/schemas/Product,
 * and the names differ because one side is TypeScript and the other is the wire format.
 */
export function toApiProduct(product: Product): ApiProduct {
    return {
        id: product.id,
        title: product.title,
        price_cents: product.priceCents,
        currency: product.currency,
        in_stock: product.inStock,
    };
}

/**
 * The card: the same five fields plus what has been sold. A separate mapper rather than a
 * spread, for the reason `toOrderPlacedEvent` is one — the shape that crosses a boundary
 * is decided here, not inherited from whatever the query happened to select.
 */
export function toApiProductCard(row: ProductCardRow): ApiProductCard {
    return {
        id: row.id,
        title: row.title,
        price_cents: row.priceCents,
        currency: row.currency,
        in_stock: row.inStock,
        units_sold: row.unitsSold,
        revenue_cents: row.revenueCents,
    };
}
