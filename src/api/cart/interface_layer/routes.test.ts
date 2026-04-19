import { Request, Response, NextFunction } from 'express';
import { createCartRouter, CartRouterDependencies } from './routes';
import { CartController } from '../../../services/cart/manager/cart.controller';
import { Logger } from 'pino';

describe('Cart Router', () => {
  let mockCartController: jest.Mocked<CartController>;
  let mockLogger: jest.Mocked<Logger>;
  let mockAuthMiddleware: jest.Mock;

  beforeEach(() => {
    mockCartController = {
      getCart: jest.fn(),
      addItem: jest.fn(),
      updateQuantity: jest.fn(),
      removeItem: jest.fn(),
    } as any;
    
    mockLogger = {
        info: jest.fn(),
        error: jest.fn(),
    } as any;

    mockAuthMiddleware = jest.fn(() => (req: Request, res: Response, next: NextFunction) => next());
  });

  it('should create the cart router', () => {
    const deps: CartRouterDependencies = {
      cartController: mockCartController,
      logger: mockLogger,
      authMiddleware: mockAuthMiddleware,
    };
    const router = createCartRouter(deps);
    expect(router).toBeDefined();
  });
});
