import { Logger } from 'pino';
import { randomUUID } from 'crypto';
import { 
  Cart, 
  CartItem, 
  CartSummary, 
  CartStatus, 
  CartConcurrencyError 
} from '../../../domain/cart.types';
import { CartLockManager } from '../../locks/cart_lock_manager';
import { CartRepository } from '../../repository/cart_repository';
import { CartMerger } from '../merger/cart_merger';

export class CartServiceError extends Error {
  constructor(public message: string, public statusCode: number = 500) {
    super(message);
    this.name = 'CartServiceError';
  }
}

export class CartService {
  constructor(
    private readonly repository: CartRepository,
    private readonly lockManager: CartLockManager,
    private readonly merger: CartMerger,
    private readonly logger: Logger
  ) {}

  public async getCart(userId: string, cartId: string): Promise<Cart> {
    try {
      const cart = await this.repository.findById(cartId);
      if (!cart || cart.userId !== userId) {
        throw new CartServiceError('Cart not found', 404);
      }
      return cart;
    } catch (error) {
      this.logger.error({ userId, cartId, error }, 'Error retrieving cart');
      throw new CartServiceError('Failed to retrieve cart', 503);
    }
  }

  public async addItem(userId: string, cartId: string, item: CartItem): Promise<Cart> {
    return this.lockManager.withLock(userId, 30, async () => {
      const cart = await this.repository.findById(cartId);
      if (!cart) throw new CartServiceError('Cart not found', 404);

      const existingItemIndex = cart.items.findIndex(i => i.productId === item.productId);
      if (existingItemIndex > -1) {
        cart.items[existingItemIndex].quantity += item.quantity;
        cart.items[existingItemIndex].updatedAt = new Date().toISOString();
      } else {
        cart.items.push(item);
      }

      const updatedCart = this.updateCartState(cart);
      await this.repository.save(updatedCart);
      return updatedCart;
    });
  }

  public async removeItem(userId: string, cartId: string, productId: string): Promise<Cart> {
    return this.lockManager.withLock(userId, 30, async () => {
      const cart = await this.repository.findById(cartId);
      if (!cart) throw new CartServiceError('Cart not found', 404);

      cart.items = cart.items.filter(i => i.productId !== productId);
      const updatedCart = this.updateCartState(cart);
      await this.repository.save(updatedCart);
      return updatedCart;
    });
  }

  public async mergeCarts(userId: string, userCartId: string, guestCartId: string): Promise<Cart> {
    return this.lockManager.withLock(userId, 60, async () => {
      const userCart = await this.repository.findById(userCartId);
      const guestCart = await this.repository.findById(guestCartId);

      if (!userCart || !guestCart) {
        throw new CartServiceError('One or more carts not found', 404);
      }

      const mergedCart = this.merger.merge(userCart, guestCart);
      const finalizedCart = this.updateCartState(mergedCart);
      
      await this.repository.delete(guestCartId);
      await this.repository.save(finalizedCart);
      
      return finalizedCart;
    });
  }

  public async checkHealth(): Promise<boolean> {
    try {
      return await this.repository.ping();
    } catch {
      return false;
    }
  }

  private updateCartState(cart: Cart): Cart {
    const summary = this.calculateSummary(cart.items);
    return {
      ...cart,
      summary,
      updatedAt: new Date().toISOString(),
      version: cart.version + 1
    };
  }

  private calculateSummary(items: CartItem[]): CartSummary {
    let subtotal = 0n;
    for (const item of items) {
      subtotal += BigInt(item.quantity) * item.pricePerUnit;
    }
    
    // Example tax calculation logic (e.g., 10%)
    const taxTotal = subtotal / 10n;
    const shippingTotal = 500n; // Fixed shipping for example
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
