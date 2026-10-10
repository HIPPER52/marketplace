import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import { Product } from '../entities/product.entity';

/**
 * Reads of the catalogue. A repository rather than a QueryBuilder because every answer
 * here is a row of `products` and the rows it relates to — see README, "Repository or
 * QueryBuilder".
 */
@Injectable()
export class ProductsRepository {
    private readonly products: Repository<Product>;

    constructor(@Inject(DATA_SOURCE) dataSource: DataSource) {
        this.products = dataSource.getRepository(Product);
    }

    /**
     * One page plus the total, which is what turns into `next_cursor`.
     *
     * The order is `created_at, id` and not `created_at` alone: seeded rows share a
     * timestamp to the microsecond, and an unstable sort under OFFSET returns the same
     * product on two pages and drops another entirely.
     */
    async page(limit: number, offset: number): Promise<{ rows: Product[]; total: number }> {
        const [rows, total] = await this.products.findAndCount({
            order: { createdAt: 'ASC', id: 'ASC' },
            skip: offset,
            take: limit,
        });

        return { rows, total };
    }

    findById(id: string): Promise<Product | null> {
        return this.products.findOne({ where: { id } });
    }
}
