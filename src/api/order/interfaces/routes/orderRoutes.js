"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrderRouter = void 0;
const express_1 = require("express");
const orderSchemas_1 = require("../../../../domain/order/schemas/orderSchemas");
/**
 * Creates the Express router for Order Management.
 * Implements security, validation, observability, and circuit breaking.
 */
const createOrderRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { orderController, logger, authMiddleware, rbacMiddleware, validateSchema, errorHandler, correlationMiddleware } = deps;
    // Global Middleware
    router.use(correlationMiddleware);
    /**
     * POST /orders
     * Initiates order checkout.
     */
    router.post('/', authMiddleware(), rbacMiddleware(['order:write']), validateSchema(orderSchemas_1.OrderRequestSchema), async (req, res, next) => {
        try {
            await orderController.createOrder(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * GET /orders
     * Lists orders for the authenticated user.
     */
    router.get('/', authMiddleware(), rbacMiddleware(['order:read']), async (req, res, next) => {
        try {
            await orderController.listOrders(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * GET /orders/:id
     * Retrieves order details.
     */
    router.get('/:id', authMiddleware(), rbacMiddleware(['order:read']), async (req, res, next) => {
        try {
            await orderController.getOrderById(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * PATCH /orders/:id
     * Handles order state transitions.
     */
    router.patch('/:id', authMiddleware(), rbacMiddleware(['order:write']), async (req, res, next) => {
        try {
            await orderController.updateOrderStatus(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    /**
     * DELETE /orders/:id
     * Cancels an order.
     */
    router.delete('/:id', authMiddleware(), rbacMiddleware(['order:write']), async (req, res, next) => {
        try {
            await orderController.cancelOrder(req, res);
        }
        catch (error) {
            next(error);
        }
    });
    // Global error handler
    router.use(errorHandler);
    return router;
};
exports.createOrderRouter = createOrderRouter;
