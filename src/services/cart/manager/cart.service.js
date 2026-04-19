"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CartService = void 0;
const crypto_1 = require("crypto");
const cart_types_1 = require("./cart.types");
class CartService {
    constructor(repository, lockManager, merger, logger) {
        this.repository = repository;
        this.lockManager = lockManager;
        this.merger = merger;
        this.logger = logger;
    }
    async getCart(userId, cartId) {
        const correlationId = (0, crypto_1.randomUUID)();
        try {
            const cart = await this.repository.getCart(userId, correlationId);
            return {
                cartId,
                userId,
                items: Object.values(cart),
                summary: this.calculateSummary(Object.values(cart)),
                status: cart_types_1.CartStatus.ACTIVE,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                lockId: (0, crypto_1.randomUUID)(),
                version: 0,
                correlationId,
                requestId: (0, crypto_1.randomUUID)()
            };
        }
        catch (error) {
            this.logger.error({ userId, cartId, error }, 'Error retrieving cart');
            if (error instanceof cart_types_1.CartServiceError)
                throw error;
            throw new cart_types_1.CartServiceError('Failed to retrieve cart', 'SERVICE_ERROR', correlationId, error);
        }
    }
    async addItem(userId, cartId, item) {
        const correlationId = (0, crypto_1.randomUUID)();
        return this.lockManager.withLock(userId, 30, async () => {
            const cartItems = await this.repository.getCart(userId, correlationId);
            const existingItem = cartItems[item.productId];
            const cartItem = {
                productId: item.productId,
                sku: item.sku || 'N/A',
                quantity: item.quantity,
                pricePerUnit: item.pricePerUnit || 0n,
                currency: item.currency || 'USD',
                addedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            if (existingItem) {
                cartItem.quantity += existingItem.quantity;
            }
            await this.repository.updateCart(userId, cartItem, correlationId);
            return this.getCart(userId, cartId);
        });
    }
    async removeItem(userId, cartId, productId) {
        const correlationId = (0, crypto_1.randomUUID)();
        return this.lockManager.withLock(userId, 30, async () => {
            await this.repository.removeItem(userId, productId, correlationId);
            return this.getCart(userId, cartId);
        });
    }
    async mergeCarts(userId, userCartId, guestCartId) {
        const correlationId = (0, crypto_1.randomUUID)();
        await this.merger.merge(guestCartId, userId, correlationId);
        return this.getCart(userId, userCartId);
    }
    async checkHealth() {
        const correlationId = (0, crypto_1.randomUUID)();
        try {
            await this.repository.checkHealth(correlationId);
            return true;
        }
        catch {
            return false;
        }
    }
    calculateSummary(items) {
        let subtotal = 0n;
        for (const item of items) {
            subtotal += BigInt(item.quantity) * item.pricePerUnit;
        }
        const taxTotal = subtotal / 10n;
        const shippingTotal = 500n;
        const discountTotal = 0n;
        return {
            subtotal,
            taxTotal,
            shippingTotal,
            discountTotal,
            grandTotal: subtotal + taxTotal + shippingTotal - discountTotal
        };
    }
}
exports.CartService = CartService;
