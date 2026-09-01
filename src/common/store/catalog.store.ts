import type { Order, Product } from '../types/api.types';

const products: Product[] = [
    {
        id: '6f1c2a34-0d51-4b8e-9a7d-1f2e3c4b5a60',
        title: 'Mechanical keyboard',
        price_cents: 260000,
        currency: 'UAH',
        in_stock: 7,
    },
    {
        id: '7a2d3b45-1e62-4c9f-8b6e-2a3f4d5c6b71',
        title: 'Ergonomic mouse',
        price_cents: 89000,
        currency: 'UAH',
        in_stock: 23,
    },
    {
        id: '8b3e4c56-2f73-4daf-9c5f-3b4a5e6d7c82',
        title: '27" 4K monitor',
        price_cents: 1450000,
        currency: 'UAH',
        in_stock: 4,
    },
    {
        id: '9c4f5d67-3a84-4ebf-8d6a-4c5b6f7e8d93',
        title: 'USB-C docking station',
        price_cents: 520000,
        currency: 'UAH',
        in_stock: 0,
    },
    {
        id: 'ad5a6e78-4b95-4fcf-9e7b-5d6c7a8f9ea4',
        title: 'Laptop stand',
        price_cents: 74000,
        currency: 'UAH',
        in_stock: 15,
    },
];

const orders: Order[] = [];

export function listProducts(): readonly Product[] {
    return products;
}

export function findProduct(id: string): Product | undefined {
    return products.find((product) => product.id === id);
}

export function listOrders(): readonly Order[] {
    return [...orders].reverse();
}

export function findOrder(id: string): Order | undefined {
    return orders.find((order) => order.id === id);
}

export function saveOrder(order: Order): void {
    orders.push(order);
}
