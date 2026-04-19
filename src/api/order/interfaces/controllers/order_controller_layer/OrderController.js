"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderController = void 0;
const uuid_1 = require("uuid");
const orderValidation_1 = require("../../validation/orderValidation");
const zod_1 = require("zod");
/**
 * OrderController handles the incoming HTTP lifecycle for order placement and management.
 * Enforces strict validation, PII redaction, and error mapping to HTTP status codes.
 */
class OrderController {
    constructor(checkoutProcessor, logger, errorMapper) {
        this.checkoutProcessor = checkoutProcessor;
        this.logger = logger;
        this.errorMapper = errorMapper;
    }
    /**
     * Handles POST /orders
     * Initiates order checkout.
     */
    async createOrder(req, res) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        const startTime = Date.now();
        req.log?.info({
            msg: 'Received createOrder request',
            correlationId,
            path: req.path,
            method: req.method,
        });
        try {
            // 1. Schema Validation
            const validationResult = orderValidation_1.CheckoutRequestSchema.safeParse(req.body);
            if (!validationResult.success) {
                this.logError(req, correlationId, 'Validation failed', validationResult.error);
                res.status(400).json({
                    error: 'Bad Request',
                    details: validationResult.error.issues,
                    correlationId,
                });
                return;
            }
            // 2. Business Logic Execution
            const orderData = validationResult.data;
            const result = await this.checkoutProcessor.processCheckout({
                ...orderData,
                orderId: (0, uuid_1.v4)(),
                userId: req.user?.sub,
                correlationId,
            });
            // 3. Success Response
            this.logCompletion(req, correlationId, startTime, 201);
            res.status(201).json({
                data: result,
                meta: { trace_id: correlationId, timestamp: new Date().toISOString() },
            });
        }
        catch (error) {
            this.handleError(error, req, res);
        }
    }
    /**
     * GET /orders/:id
     */
    async getOrderById(req, res) {
        const { id } = req.params;
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        try {
            const order = await this.checkoutProcessor.getOrderById(id);
            res.status(200).json(order);
        }
        catch (error) {
            this.handleError(error, req, res);
        }
    }
    /**
     * GET /orders
     */
    async listOrders(req, res) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        const userId = req.user?.sub;
        try {
            if (!userId) {
                res.status(401).json({ error: 'Unauthorized', correlationId });
                return;
            }
            const orders = await this.checkoutProcessor.listOrdersByUserId(userId);
            res.status(200).json(orders);
        }
        catch (error) {
            this.handleError(error, req, res);
        }
    }
    /**
     * PATCH /orders/:id
     */
    async updateOrderStatus(req, res) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        const { id } = req.params;
        const { status } = req.body;
        try {
            await this.checkoutProcessor.updateStatus(id, status);
            res.status(200).json({ message: 'Order status updated' });
        }
        catch (error) {
            this.handleError(error, req, res);
        }
    }
    /**
     * DELETE /orders/:id
     */
    async cancelOrder(req, res) {
        const correlationId = req.headers['x-correlation-id'] || (0, uuid_1.v4)();
        const { id } = req.params;
        try {
            await this.checkoutProcessor.updateStatus(id, 'CANCELLED');
            res.status(200).json({ message: 'Order cancelled' });
        }
        catch (error) {
            this.handleError(error, req, res);
        }
    }
    handleError(error, req, res) {
        this.errorMapper.handle(error, req, res);
    }
    logError(req, correlationId, message, error) {
        const errorDetails = error instanceof zod_1.ZodError ? error.issues : String(error);
        req.log?.error({
            msg: message,
            correlationId,
            error: errorDetails,
        });
    }
    logCompletion(req, correlationId, startTime, statusCode) {
        const duration = Date.now() - startTime;
        req.log?.info({
            msg: 'Request completed',
            correlationId,
            durationMs: duration,
            statusCode,
        });
    }
}
exports.OrderController = OrderController;
