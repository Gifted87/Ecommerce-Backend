"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderTransitionEngine = exports.CalculationMismatchError = exports.InvalidTransitionError = void 0;
const decimal_js_1 = require("decimal.js");
const order_types_1 = require("../types/order_types");
/**
 * Custom error thrown when a requested state transition is not permitted.
 */
class InvalidTransitionError extends Error {
    constructor(current, next) {
        super(`Invalid transition from ${current} to ${next}`);
        this.current = current;
        this.next = next;
        this.name = 'InvalidTransitionError';
    }
}
exports.InvalidTransitionError = InvalidTransitionError;
/**
 * Custom error thrown when financial calculations do not match the expected totals.
 */
class CalculationMismatchError extends Error {
    constructor(message) {
        super(message);
        this.message = message;
        this.name = 'CalculationMismatchError';
    }
}
exports.CalculationMismatchError = CalculationMismatchError;
/**
 * The OrderTransitionEngine is a stateless service responsible for:
 * 1. Validating state machine transitions.
 * 2. High-precision financial arithmetic.
 * 3. Ensuring contextual integrity for state changes.
 */
class OrderTransitionEngine {
    constructor(logger) {
        this.logger = logger;
    }
    /**
     * Validates if the transition from currentStatus to nextStatus is allowed
     * and verifies required context.
     */
    validateTransition(currentStatus, nextStatus, context) {
        const allowed = order_types_1.OrderTransitions[currentStatus];
        if (!allowed.includes(nextStatus)) {
            this.logger.error({
                msg: 'Illegal state transition attempt',
                current: currentStatus,
                next: nextStatus,
            });
            throw new InvalidTransitionError(currentStatus, nextStatus);
        }
        if (nextStatus === order_types_1.OrderStatus.SHIPPED) {
            if (!context?.tracking_number || context.tracking_number.trim().length === 0) {
                this.logger.error({
                    msg: 'Transition to SHIPPED missing tracking number',
                    current: currentStatus,
                });
                throw new Error('MISSING_FULFILLMENT_INFO: Tracking number is required for SHIPPED status');
            }
        }
    }
    /**
     * Calculates the total order amount from items and compares it with the expected total.
     * Utilizes decimal.js for financial precision.
     *
     * @throws CalculationMismatchError if internal calculations do not align.
     */
    verifyOrderFinancials(items, totalAmount) {
        let calculatedTotal = new decimal_js_1.Decimal(0);
        for (const item of items) {
            const unitPrice = new decimal_js_1.Decimal(item.unit_price);
            const quantity = new decimal_js_1.Decimal(item.quantity);
            const expectedItemTotal = unitPrice.mul(quantity);
            const actualItemTotal = new decimal_js_1.Decimal(item.item_total);
            if (!expectedItemTotal.equals(actualItemTotal)) {
                this.logger.error({
                    msg: 'Item total calculation mismatch',
                    sku: item.sku,
                    expected: expectedItemTotal.toString(),
                    actual: actualItemTotal.toString(),
                });
                throw new CalculationMismatchError(`Mismatch for SKU ${item.sku}: expected ${expectedItemTotal} but got ${actualItemTotal}`);
            }
            calculatedTotal = calculatedTotal.add(actualItemTotal);
        }
        const expectedTotal = new decimal_js_1.Decimal(totalAmount);
        if (!calculatedTotal.equals(expectedTotal)) {
            this.logger.error({
                msg: 'Order total mismatch',
                calculated: calculatedTotal.toString(),
                provided: expectedTotal.toString(),
            });
            throw new CalculationMismatchError('Calculated order total does not match provided total');
        }
    }
    /**
     * Orchestrates the transition validation and log emission.
     * This is the entry point for the order state manager.
     */
    async processTransition(orderId, currentStatus, nextStatus, context) {
        this.logger.info({
            msg: 'Processing order state transition',
            orderId,
            from: currentStatus,
            to: nextStatus,
        });
        this.validateTransition(currentStatus, nextStatus, context);
        this.logger.info({
            msg: 'Transition validated successfully',
            orderId,
            to: nextStatus,
        });
    }
}
exports.OrderTransitionEngine = OrderTransitionEngine;
