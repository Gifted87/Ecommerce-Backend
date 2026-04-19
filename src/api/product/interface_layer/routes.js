"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProductRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const opossum_1 = __importDefault(require("opossum"));
const uuid_1 = require("uuid");
/**
 * Zod Schemas for Request Validation
 */
const GetProductsSchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().positive().default(20),
    offset: zod_1.z.coerce.number().int().nonnegative().default(0),
    category: zod_1.z.string().optional(),
    priceRange: zod_1.z.string().regex(/^\d+-\d+$/).optional(),
});
const InventoryReserveSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    quantity: zod_1.z.number().int().positive(),
});
/**
 * Routes definition for Catalog and Inventory
 */
const createProductRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { logger, catalogService, inventoryProcessor, authMiddleware } = deps;
    // Circuit Breaker Options
    const breakerOptions = { timeout: 3000, errorThresholdPercentage: 50, resetTimeout: 30000 };
    const catalogBreaker = new opossum_1.default(async (params) => await catalogService.getProductBySku(params.sku, params.correlationId), breakerOptions);
    /**
     * GET /products/:sku - Get product details
     */
    router.get('/products/:sku', async (req, res, next) => {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        try {
            const product = await catalogBreaker.fire({ sku: req.params.sku, correlationId });
            if (!product) {
                return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
            }
            res.status(200).json({ data: product, meta: { correlationId } });
        }
        catch (err) {
            logger.error({ err, correlationId }, 'Error fetching product');
            res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Catalog service currently unavailable' });
        }
    });
    /**
     * POST /inventory/reserve - Reserve inventory
     */
    router.post('/inventory/reserve', authMiddleware({ requiredRoles: ['USER', 'SERVICE_ACCOUNT'] }), async (req, res, next) => {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        const idempotencyKey = req.headers['x-idempotency-key'];
        if (!idempotencyKey) {
            return res.status(400).json({ code: 'MISSING_IDEMPOTENCY_KEY', message: 'X-Idempotency-Key header is required' });
        }
        try {
            const validated = InventoryReserveSchema.parse(req.body);
            await inventoryProcessor.reserveStock({
                productId: validated.productId,
                amount: validated.quantity,
                correlationId,
                userId: req.user?.sub || 'system',
            });
            res.status(201).json({ status: 'RESERVED', correlationId });
        }
        catch (err) {
            if (err instanceof zod_1.z.ZodError) {
                return res.status(400).json({ code: 'INVALID_INPUT', errors: err.errors });
            }
            // Translate domain-specific errors
            if (err.name === 'InsufficientStockError') {
                return res.status(409).json({ code: 'INSUFFICIENT_STOCK', message: err.message });
            }
            logger.error({ err, correlationId, productId: req.body.productId }, 'Inventory reservation failed');
            res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Inventory service temporarily unavailable' });
        }
    });
    return router;
};
exports.createProductRouter = createProductRouter;
