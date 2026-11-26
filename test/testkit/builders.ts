import type { EntityManager } from 'typeorm';
import { Currency } from '../../src/common/constants/currency.constant';
import { OrderStatus } from '../../src/orders/constants/order-status.constant';
import { Order } from '../../src/orders/entities/order.entity';
import { OrderItem } from '../../src/orders/entities/order-item.entity';
import { Product } from '../../src/products/entities/product.entity';
import { User } from '../../src/users/entities/user.entity';

/**
 * Test data builders: valid defaults, unique where the schema demands uniqueness, and a
 * chain of `with*()` for the one field a given test is actually about.
 *
 * The alternative is fifteen lines of arrange in every test, in which the field under
 * test is indistinguishable from the fourteen that are only there to satisfy a NOT NULL.
 * Here `aUser().withEmail('DUP@example.com')` says what the test is about and the builder
 * keeps the rest quiet.
 */
let sequence = 0;

function next(): number {
    sequence += 1;
    return sequence;
}

export class UserBuilder {
    private readonly ordinal = next();
    private email = `user-${this.ordinal}@example.com`;
    private displayName = `User ${this.ordinal}`;
    private balanceCents = 10_000_000;

    withEmail(email: string): this {
        this.email = email;
        return this;
    }

    withBalance(cents: number): this {
        this.balanceCents = cents;
        return this;
    }

    build(): User {
        const user = new User();
        user.email = this.email;
        user.displayName = this.displayName;
        user.balanceCents = this.balanceCents;
        return user;
    }

    insertVia(manager: EntityManager): Promise<User> {
        return manager.save(this.build());
    }
}

export class ProductBuilder {
    private readonly ordinal = next();
    private title = `Product ${this.ordinal}`;
    private description = `Description of product ${this.ordinal}`;
    private priceCents = 100_000;
    private currency: Currency = Currency.UAH;
    private inStock = 10;

    withTitle(title: string): this {
        this.title = title;
        return this;
    }

    withPrice(cents: number): this {
        this.priceCents = cents;
        return this;
    }

    withCurrency(currency: Currency): this {
        this.currency = currency;
        return this;
    }

    withStock(units: number): this {
        this.inStock = units;
        return this;
    }

    build(): Product {
        const product = new Product();
        product.title = this.title;
        product.description = this.description;
        product.priceCents = this.priceCents;
        product.currency = this.currency;
        product.inStock = this.inStock;
        return product;
    }

    insertVia(manager: EntityManager): Promise<Product> {
        return manager.save(this.build());
    }
}

interface Line {
    product: Product;
    quantity: number;
}

export class OrderBuilder {
    private buyer?: User;
    private readonly lines: Line[] = [];
    private status: OrderStatus = OrderStatus.Pending;
    private currency: Currency = Currency.UAH;

    for(user: User): this {
        this.buyer = user;
        return this;
    }

    with(product: Product, quantity = 1): this {
        this.lines.push({ product, quantity });
        return this;
    }

    withStatus(status: OrderStatus): this {
        this.status = status;
        return this;
    }

    build(): Order {
        if (this.buyer === undefined) {
            throw new Error('anOrder() needs a buyer: call .for(await aUser().insertVia(…)).');
        }

        const order = new Order();
        order.user = this.buyer;
        order.status = this.status;
        order.currency = this.currency;
        order.items = this.lines.map((line) => {
            const item = new OrderItem();
            item.product = line.product;
            item.quantity = line.quantity;
            item.unitPriceCents = line.product.priceCents;
            item.subtotalCents = line.product.priceCents * line.quantity;
            return item;
        });
        order.totalCents = order.items.reduce((sum, item) => sum + item.subtotalCents, 0);

        return order;
    }

    /** `cascade: true` on Order.items is what writes the line items in this one call. */
    insertVia(manager: EntityManager): Promise<Order> {
        return manager.save(this.build());
    }
}

export function aUser(): UserBuilder {
    return new UserBuilder();
}

export function aProduct(): ProductBuilder {
    return new ProductBuilder();
}

export function anOrder(): OrderBuilder {
    return new OrderBuilder();
}
