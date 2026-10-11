import { Job } from '../../jobs/entities/job.entity';
import { Order } from '../../orders/entities/order.entity';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { Product } from '../../products/entities/product.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Every entity, in one place, because three DataSources are built from it: the CLI's in
 * data-source.ts, the application's in services/data-source.factory.ts, and the one the
 * integration tests point at a throwaway container. An entity registered in two of the
 * three is an entity that works until the suite is the thing that has to find it.
 */
export const ENTITIES = [User, Product, Order, OrderItem, Job];
