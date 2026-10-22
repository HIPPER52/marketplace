import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import type { ProductCardCache } from '../../cache/services/product-card-cache.service';
import { CardJob, WARM_BATCH } from '../constants/queue.constant';

export interface RefreshData {
    productId: string;
}

/**
 * The consumer side of the card queue.
 *
 * Two kinds of work, both of them "recompute a card and publish it", differing only in how
 * the card is chosen:
 *
 *   - `refresh-card` names one product, and arrives because an order moved its stock.
 *   - `warm-hot-cards` picks the products that sold most recently and refreshes those, so
 *     a popular card's TTL expires against a background job instead of against a customer.
 *     This is the cheap half of stampede protection: the lock keeps a crowd from becoming
 *     a crowd of queries, and the warmer keeps the crowd from forming.
 *
 * A plain class rather than a Nest provider, for the same reason `OrderPlacedConsumer` is
 * one: it runs in `npm run start:cards`, a process of its own, and a web server and a
 * worker scale on different numbers.
 */
export class CardWorker {
    readonly tally = { refreshed: 0, warmed: 0 };

    constructor(
        private readonly cache: ProductCardCache,
        private readonly dataSource: DataSource,
    ) {}

    async process(job: Job): Promise<void> {
        if (job.name === CardJob.Warm) {
            await this.warm();
            return;
        }

        const { productId } = job.data as RefreshData;
        await this.cache.refresh(productId);
        this.tally.refreshed += 1;
    }

    private async warm(): Promise<void> {
        for (const productId of await this.recentlySold()) {
            await this.cache.refresh(productId);
            this.tally.warmed += 1;
        }
    }

    /**
     * The products whose cards are most likely to be read next.
     *
     * "Recently ordered" rather than "most read": the service does not count reads, and
     * inventing a counter for this would be a second source of truth about popularity when
     * the orders table already holds one.
     */
    private async recentlySold(limit = WARM_BATCH): Promise<string[]> {
        const rows = await this.dataSource.query<{ product_id: string }[]>(
            `SELECT oi.product_id
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
              GROUP BY oi.product_id
              ORDER BY max(o.created_at) DESC
              LIMIT $1`,
            [limit],
        );

        return rows.map((row) => row.product_id);
    }
}
