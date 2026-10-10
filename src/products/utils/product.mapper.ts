import type { Product as ApiProduct } from '../../common/types/api.types';
import type { Product } from '../entities/product.entity';

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
