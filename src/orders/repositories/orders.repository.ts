import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import { Order } from '../entities/order.entity';

/**
 * Reads of placed orders. Writing one is CheckoutService's job, not this class's: an
 * order is created by a transaction that also moves stock and money, and a repository
 * with a `save` on it would invite someone to write half of that.
 *
 * `relationLoadStrategy: 'query'` is the #13 result made permanent. The default joins the
 * line items into the parent query, which makes LIMIT count joined rows rather than
 * orders; 'query' issues one statement for the page and one for its items — two
 * statements for any page size, which is the property that stops this being an N+1.
 */
@Injectable()
export class OrdersRepository {
    private readonly orders: Repository<Order>;

    constructor(@Inject(DATA_SOURCE) dataSource: DataSource) {
        this.orders = dataSource.getRepository(Order);
    }

    async page(limit: number, offset: number): Promise<{ rows: Order[]; total: number }> {
        const [rows, total] = await this.orders.findAndCount({
            relations: { items: true },
            relationLoadStrategy: 'query',
            order: { createdAt: 'DESC', id: 'ASC' },
            skip: offset,
            take: limit,
        });

        return { rows, total };
    }

    findById(id: string): Promise<Order | null> {
        return this.orders.findOne({
            where: { id },
            relations: { items: true },
            relationLoadStrategy: 'query',
        });
    }
}
