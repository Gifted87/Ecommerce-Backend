"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCartRouter = void 0;
const express_1 = require("express");
/**
 * Configures and returns the Express router for the Cart API.
 *
 * @param deps - Dependencies including controller and middleware.
 * @returns {Router} Configured Express router.
 */
const createCartRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { cartController, authMiddleware } = deps;
    /**
     * GET /api/v1/cart/:cartId
     */
    router.get('/:cartId', authMiddleware(), (req, res) => {
        cartController.getCart(req, res);
    });
    /**
     * POST /api/v1/cart/:cartId/items
     */
    router.post('/:cartId/items', authMiddleware(), (req, res) => {
        cartController.addItem(req, res);
    });
    /**
     * PATCH /api/v1/cart/:cartId/items
     */
    router.patch('/:cartId/items', authMiddleware(), (req, res) => {
        cartController.updateQuantity(req, res);
    });
    /**
     * DELETE /api/v1/cart/:cartId/items/:productId
     */
    router.delete('/:cartId/items/:productId', authMiddleware(), (req, res) => {
        cartController.removeItem(req, res);
    });
    return router;
};
exports.createCartRouter = createCartRouter;
