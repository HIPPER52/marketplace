import type { components } from '../../generated/api';

export type Product = components['schemas']['Product'];
export type ProductCard = components['schemas']['ProductCard'];
export type Order = components['schemas']['Order'];
export type OrderItem = components['schemas']['OrderItem'];
export type CreateOrderRequest = components['schemas']['CreateOrderRequest'];
export type UpdateOrderStatusRequest = components['schemas']['UpdateOrderStatusRequest'];
export type Problem = components['schemas']['Problem'];
export type CreateProductRequest = components['schemas']['CreateProductRequest'];
export type LoginRequest = components['schemas']['LoginRequest'];
export type RefreshRequest = components['schemas']['RefreshRequest'];
export type LogoutRequest = components['schemas']['LogoutRequest'];
export type TokenPairResponse = components['schemas']['TokenPair'];
export type Identity = components['schemas']['Identity'];
export type CreateUploadIntentRequest = components['schemas']['CreateUploadIntentRequest'];
export type UploadIntent = components['schemas']['UploadIntent'];
export type CommitUploadRequest = components['schemas']['CommitUploadRequest'];
export type StoredFileResponse = components['schemas']['StoredFile'];
