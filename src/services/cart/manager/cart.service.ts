import { Logger } from 'pino';
import { randomUUID } from 'crypto';
import { 
  Cart, 
  CartItem, 
  CartSummary, 
  CartStatus
} from './cart.types';
import { CartGeneralError } from './cart.errors';
import { CartLockManager } from './cart.lock.manager';
import { CartRepository } from './cart.repository';
import { CartMerger } from './cart.merger';

/**
 * CartService provides the primary business logic for managing shopping carts.
 * 
 * It handles cart retrieval, item addition, quantity updates, and merging of guest
 * carts into user accounts. All operations that modify the cart state are
 * protected by a distributed lock to ensure consistency in high-concurrency environments.
 * 
 * Uses the CartRepository for persistence and CartLockManager for concurrency control.
 */
export class CartService {
  constructor(
    private readonly repository: CartRepository,
    private readonly lockManager: CartLockManager,
    private readonly merger: CartMerger,
    private readonly logger: Logger
  ) {}

  /**
   * Retrieves the current state of a user's cart.
   * 
   * @param userId - The unique identifier of the user owning the cart.
   * @param cartId - The session or permanent ID of the cart to retrieve.
   * @param correlationId - Unique ID for tracing across services (defaults to random UUID).
   * @returns A promise resolving to the complete Cart object, including summary and items.
   * @throws CartServiceError if the cart cannot be retrieved from the repository.
   */
  public async getCart(userId: string, cartId: string, correlationId: string = randomUUID()): Promise<Cart> {
    try {
      const cart = await this.repository.getCart(userId, correlationId);
      return { 
        cartId, 
        userId, 
        items: Object.values(cart), 
        summary: this.calculateSummary(Object.values(cart)),
        status: CartStatus.ACTIVE,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lockId: randomUUID(),
        version: 0,
        correlationId,
        requestId: correlationId
      };
    } catch (error) {
      this.logger.error({ userId, cartId, error, correlationId }, 'Error retrieving cart');
      if (error instanceof CartGeneralError) throw error;
      throw new CartGeneralError('Failed to retrieve cart', { userId, metadata: { correlationId } });
    }
  }

  /**
   * Adds a new item to the user's cart or updates the quantity if it already exists.
   * 
   * @param userId - The unique identifier of the user.
   * @param cartId - The ID of the cart being modified.
   * @param item - The item details to add (productId, quantity, etc.).
   * @param correlationId - Unique ID for tracing across services.
   * @returns A promise resolving to the updated Cart object.
   * @throws CartServiceError if the lock cannot be acquired or the repository update fails.
   */
  public async addItem(userId: string, cartId: string, item: any, correlationId: string = randomUUID()): Promise<Cart> {
    return this.lockManager.withLock(userId, 30, async () => {
      const cartItems = await this.repository.getCart(userId, correlationId);
      const existingItem = cartItems[item.productId];
      
      const cartItem: CartItem = {
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
      return this.getCart(userId, cartId, correlationId);
    });
  }

  /**
   * Updates the quantity of a specific product already in the user's cart.
   * 
   * @param userId - The unique identifier of the user.
   * @param cartId - The ID of the cart being modified.
   * @param productId - The unique identifier of the product to update.
   * @param quantity - The new quantity for the product.
   * @param correlationId - Unique ID for tracing across services.
   * @returns A promise resolving to the updated Cart object.
   */
  public async updateQuantity(userId: string, cartId: string, productId: string, quantity: number, correlationId: string = randomUUID()): Promise<Cart> {
    return this.lockManager.withLock(userId, 30, async () => {
      await this.repository.updateQuantity(userId, productId, quantity, correlationId);
      return this.getCart(userId, cartId, correlationId);
    });
  }

  /**
   * Removes a product entirely from the user's cart.
   * 
   * @param userId - The unique identifier of the user.
   * @param cartId - The ID of the cart being modified.
   * @param productId - The unique identifier of the product to remove.
   * @param correlationId - Unique ID for tracing across services.
   * @returns A promise resolving to the updated Cart object.
   */
  public async removeItem(userId: string, cartId: string, productId: string, correlationId: string = randomUUID()): Promise<Cart> {
    return this.lockManager.withLock(userId, 30, async () => {
      await this.repository.removeItem(userId, productId, correlationId);
      return this.getCart(userId, cartId, correlationId);
    });
  }

  /**
   * Merges a guest cart into a registered user's cart.
   * 
   * @param userId - The unique identifier of the registered user.
   * @param userCartId - The ID of the target user cart.
   * @param guestCartId - The ID of the source guest cart to be merged.
   * @param correlationId - Unique ID for tracing across services.
   * @returns A promise resolving to the final merged Cart object for the user.
   */
  public async mergeCarts(userId: string, userCartId: string, guestCartId: string, correlationId: string = randomUUID()): Promise<Cart> {
    await this.merger.merge(guestCartId, userId, correlationId);
    return this.getCart(userId, userCartId, correlationId);
  }

  /**
   * Performs a health check on the cart service by verifying repository connectivity.
   * 
   * @returns A promise resolving to true if the service is healthy, false otherwise.
   */
  public async checkHealth(): Promise<boolean> {
    const correlationId = randomUUID();
    try {
      await this.repository.checkHealth(correlationId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Calculates the financial totals (subtotal, tax, shipping, etc.) for a list of cart items.
   * 
   * @param items - The list of items currently in the cart.
   * @returns A CartSummary object containing the calculated totals.
   */
  private calculateSummary(items: CartItem[]): CartSummary {
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
