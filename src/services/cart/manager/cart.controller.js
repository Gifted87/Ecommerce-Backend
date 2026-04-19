"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CartController = void 0;
const cart_schema_1 = require("./cart.schema");
const cart_errors_1 = require("./cart.errors");
/**
 * @fileoverview CartController
 * Orchestrates HTTP requests for cart operations, handling validation,
 * service delegation, error mapping, and observability.
 */
class CartController {
    constructor(cartService, logger, breaker) {
        this.cartService = cartService;
        this.logger = logger;
        this.breaker = breaker;
    }
    async getCart(req, res) {
        const requestId = req.headers['x-request-id'] || 'unknown';
        const userId = req.headers['x-user-id'];
        const cartId = req.params.cartId;
        if (!userId) {
            res.status(401).json({ error: 'Unauthorized', requestId });
            return;
        }
        try {
            const startTime = Date.now();
            const cart = await this.breaker.fire(async () => await this.cartService.getCart(userId, cartId));
            this.recordLatency(Date.now() - startTime, 'getCart');
            res.status(200).json(cart);
        }
        catch (error) {
            this.handleError(error, res, requestId, userId, cartId);
        }
    }
    async addItem(req, res) {
        const requestId = req.headers['x-request-id'] || 'unknown';
        const userId = req.headers['x-user-id'];
        const cartId = req.params.cartId;
        if (!userId) {
            res.status(401).json({ error: 'Unauthorized', requestId });
            return;
        }
        const validation = cart_schema_1.AddToCartSchema.safeParse(req.body);
        if (!validation.success) {
            res.status(400).json({ error: 'Validation Failed', details: validation.error.format(), requestId });
            return;
        }
        try {
            const startTime = Date.now();
            const cart = await this.breaker.fire(async () => await this.cartService.addItem(userId, cartId, validation.data));
            this.recordLatency(Date.now() - startTime, 'addItem');
            res.status(200).json(cart);
        }
        catch (error) {
            this.handleError(error, res, requestId, userId, cartId);
        }
    }
    async updateQuantity(req, res) {
        const requestId = req.headers['x-request-id'] || 'unknown';
        const userId = req.headers['x-user-id'];
        const cartId = req.params.cartId;
        if (!userId) {
            res.status(401).json({ error: 'Unauthorized', requestId });
            return;
        }
        const validation = cart_schema_1.UpdateQuantitySchema.safeParse(req.body);
        if (!validation.success) {
            res.status(400).json({ error: 'Validation Failed', details: validation.error.format(), requestId });
            return;
        }
        try {
            const startTime = Date.now();
            const cart = await this.breaker.fire(async () => await this.cartService.updateQuantity(userId, cartId, validation.data));
            this.recordLatency(Date.now() - startTime, 'updateQuantity');
            res.status(200).json(cart);
        }
        catch (error) {
            this.handleError(error, res, requestId, userId, cartId);
        }
    }
    async removeItem(req, res) {
        const requestId = req.headers['x-request-id'] || 'unknown';
        const userId = req.headers['x-user-id'];
        const cartId = req.params.cartId;
        const productId = req.params.productId;
        if (!userId) {
            res.status(401).json({ error: 'Unauthorized', requestId });
            return;
        }
        const validation = cart_schema_1.RemoveItemSchema.safeParse({ productId });
        if (!validation.success) {
            res.status(400).json({ error: 'Validation Failed', details: validation.error.format(), requestId });
            return;
        }
        try {
            const startTime = Date.now();
            const cart = await this.breaker.fire(async () => await this.cartService.removeItem(userId, cartId, validation.data.productId));
            this.recordLatency(Date.now() - startTime, 'removeItem');
            res.status(200).json(cart);
        }
        catch (error) {
            this.handleError(error, res, requestId, userId, cartId);
        }
    }
    handleError(error, res, requestId, userId, cartId) {
        this.logger.error({ error, requestId, userId, cartId }, 'Cart operation failed');
        if (error instanceof cart_errors_1.CartNotFoundError) {
            res.status(404).json({ error: error.message, code: error.errorCode, requestId });
        }
        else if (error instanceof cart_errors_1.CartConcurrencyError) {
            res.status(409).json({ error: 'Conflict: Please retry your request', code: error.errorCode, requestId });
        }
        else if (error instanceof cart_errors_1.CartItemValidationError) {
            res.status(422).json({ error: error.message, code: error.errorCode, requestId });
        }
        else if (error.code === 'EOPENBREAKER') {
            res.status(503).json({ error: 'Service Unavailable: Circuit Open', requestId });
        }
        else {
            res.status(500).json({ error: 'Internal Server Error', requestId });
        }
    }
    recordLatency(durationMs, operation) {
        // Integration with centralized monitoring system
        this.logger.info({ operation, durationMs }, 'Operation latency tracked');
    }
}
exports.CartController = CartController;
