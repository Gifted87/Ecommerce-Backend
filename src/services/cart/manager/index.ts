/**
 * @fileoverview Entry point for the Cart and Session Management service.
 * Exports types, schemas, services, and controllers for external consumption.
 */

export * from './cart.types';
// Explicitly exclude CartItem to avoid collision
export { AddToCartSchema, UpdateQuantitySchema, RemoveItemSchema, ZodCartItem, AddToCartRequest, UpdateQuantityRequest, RemoveItemRequest } from './cart.schema';
export * from './cart.errors';
export { CartService } from './cart.service';
export { CartRepository } from './cart.repository';
export { CartLockManager } from './cart.lock.manager';
export { CartMerger } from './cart.merger';
export { CartController } from './cart.controller';
