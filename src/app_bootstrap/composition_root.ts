import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Logger } from 'pino';
import { knex } from 'knex';
import { Kafka } from 'kafkajs';
import CircuitBreaker from 'opossum';

// Shared Services
import { SecurityService } from '../shared/security/security.service';

// User Module
import { UserService } from '../services/user/auth_mfa_module/services/user.service';
import { UserRepository } from '../services/user/auth_mfa_module/services/user.repository';
import { MfaService } from '../services/user/auth_mfa_module/services/mfa.service';
import { AuthService } from '../services/user/auth_mfa_module/services/auth.service';
import { RegistrationController } from '../api/user/interface_layer/controllers/registration/registration.controller';
import { ProfileController } from '../api/user/interface_layer/controllers/profile/profile.controller';
import { MfaController } from '../api/user/interface_layer/controllers/mfa/mfaController';
import { AuthController } from '../services/user/auth_mfa_module/controllers/auth.controller';
import { createUserRouter } from '../api/user/interface_layer/routing/index';

// Product Module
import { CatalogService } from '../services/product/catalog_inventory_manager/services/catalog/catalogService';
import { InventoryProcessor } from '../services/product/catalog_inventory_manager/services/inventory/inventory_processor/InventoryProcessor';
import { InventoryRepository } from '../services/product/catalog_inventory_manager/services/inventory/inventory_processor/inventory_repository';
import { InventoryCacheManager } from '../services/product/catalog_inventory_manager/services/inventory/inventory_processor/InventoryCacheManager';
import { InventoryEventPublisher } from '../services/product/catalog_inventory_manager/services/inventory/inventory_processor/InventoryEventPublisher';
import { ProductRepository } from '../services/product/catalog_inventory_manager/repositories/product/ProductRepository';
import { createProductRouter } from '../api/product/interface_layer/routes';

// Order Module
import { OrderRepository } from '../services/order/checkout_processor/repository/orderRepository';
import { OrderStateManager } from '../services/order/checkout_processor/core/OrderStateManager';
import { OrderTransitionEngine } from '../services/order/checkout_processor/logic/OrderTransitionEngine';
import { OrderController } from '../api/order/interfaces/controllers/order_controller_layer/OrderController';
import { OrderErrorMapper } from '../api/order/interfaces/controllers/order_controller_layer/order_error_mapper';
import { CheckoutProcessorService } from '../services/order/checkout_processor/service/CheckoutProcessorService';
import { createOrderRouter } from '../api/order/interfaces/routes/orderRoutes';
import { CheckoutEventProducer } from '../services/order/checkout_processor/infrastructure/events/CheckoutEventProducer';
import { OutboxRelayService } from '../services/order/checkout_processor/infrastructure/outbox/OutboxRelayService';
import { DistributedLockService } from '../services/order/checkout_processor/infrastructure/lock/DistributedLockService';
import { KafkaMessagingClient } from '../shared/messaging/kafkaClient';
import { StripePaymentService } from '../services/order/checkout_processor/infrastructure/payment/StripePaymentService';

// Cart Module
import { CartRepository } from '../services/cart/manager/cart.repository';
import { CartLockManager } from '../services/cart/manager/cart.lock.manager';
import { CartMerger } from '../services/cart/manager/cart.merger';
import { CartService } from '../services/cart/manager/cart.service';
import { CartController } from '../services/cart/manager/cart.controller';
import { createCartRouter } from '../api/cart/interface_layer/routes';

// Middleware
import { createSecurityMiddleware } from '../api/order/interfaces/middleware/securityAndObservability';
import { validateSchema } from '../api/common/middleware/validation.middleware';
import { handleGlobalError } from '../shared/middleware/error_handler';
import { config } from './config';

export interface CompositionRoot {
  userRouter: any;
  productRouter: any;
  orderRouter: any;
  cartRouter: any;
  outboxRelay: OutboxRelayService;
}

/**
 * Orchestrates the composition of all application dependencies.
 */
export const composeDependencies = async (
  db: Pool,
  redis: Redis,
  kafka: Kafka,
  logger: Logger
): Promise<CompositionRoot> => {
  const knexInstance = knex({ client: 'postgresql', connection: db as any });

  // Build independent Redis connections for Redlock consensus.
  // REDIS_REDLOCK_NODES should be comma-separated host:port pairs (e.g. "redis1:6379,redis2:6379,redis3:6379").
  // When absent, lock managers fall back to the main redis client with a startup warning.
  const redlockNodes: Redis[] = (process.env.REDIS_REDLOCK_NODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((node) => {
      const [host, portStr] = node.split(':');
      return new Redis({
        host: host || '127.0.0.1',
        port: parseInt(portStr || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        tls: process.env.REDIS_USE_TLS === 'true' ? {} : undefined,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
    });

  const securityService = new SecurityService(config.SECURITY_MASTER_KEY, config.SECURITY_PEPPER);
  const securityMiddleware = createSecurityMiddleware(redis, logger);

  // User Module
  const userRepository = new UserRepository(db, logger);
  const userService = new UserService(userRepository, securityService, logger);
  const mfaService = new MfaService(redis, db, securityService, logger);
  const authService = new AuthService(db, redis, securityService);
  
  const userRegistrationController = new RegistrationController(userService, logger);
  const userProfileController = new ProfileController(userService, logger);
  const mfaController = new MfaController(mfaService, logger);
  const authController = new AuthController(authService, logger);

  const userRouter = createUserRouter({
    redis,
    logger,
    userRegistrationController,
    userProfileController,
    mfaController,
    authController
  });

  // Product Module
  const productRepository = new ProductRepository(knexInstance, logger);
  const catalogService = new CatalogService(productRepository, redis, logger);
  const inventoryRepository = new InventoryRepository(knexInstance, logger);
  InventoryCacheManager.initialize(logger);
  
  if (!process.env.HMAC_SECRET) {
    throw new Error('HMAC_SECRET is required.');
  }

  const inventoryEventPublisher = new InventoryEventPublisher({
      clientId: 'inventory-service',
      brokers: config.KAFKA_BROKER_URL,
      ssl: false,
      hmacSecret: process.env.HMAC_SECRET
  }, logger);
  await inventoryEventPublisher.connect();
  
  const inventoryProcessor = new InventoryProcessor(
      inventoryRepository,
      InventoryCacheManager.getInstance(),
      inventoryEventPublisher,
      logger
  );

  const productRouter = createProductRouter({
    logger,
    catalogService,
    inventoryProcessor,
    authMiddleware: (options) => securityMiddleware.authenticate(options),
    validateSchema
  });

  // Order Module
  const orderRepository = new OrderRepository(knexInstance, logger);
  const kafkaMessagingClient = new KafkaMessagingClient({
      clientId: config.KAFKA_CLIENT_ID,
      brokers: config.KAFKA_BROKER_URL,
      ssl: false,
  });
  await kafkaMessagingClient.connect();

  const checkoutEventProducer = new CheckoutEventProducer(kafkaMessagingClient, logger, {
      orderPlaced: 'orders.placed',
      orderUpdated: 'orders.updated'
  });
  const distributedLockService = new DistributedLockService(redis, logger, redlockNodes);
  const orderTransitionEngine = new OrderTransitionEngine(logger);
  
  const orderStateManager = new OrderStateManager(
    orderRepository,
    distributedLockService,
    checkoutEventProducer,
    orderTransitionEngine,
    logger
  );

  // Verify environment for external integrations
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required in environment');
  const stripePaymentService = new StripePaymentService(logger);

  const checkoutProcessorService = new CheckoutProcessorService(
      orderStateManager,
      checkoutEventProducer,
      stripePaymentService,
      logger
  );

  const orderErrorMapper = new OrderErrorMapper(logger);
  const orderController = new OrderController(checkoutProcessorService, logger, orderErrorMapper);

  const orderRouter = createOrderRouter({
    orderController,
    logger,
    authMiddleware: () => securityMiddleware.authenticate(),
    rbacMiddleware: (permissions: string[]) => securityMiddleware.authenticate({ requiredRoles: permissions }),
    validateSchema,
    errorHandler: handleGlobalError,
    correlationMiddleware: securityMiddleware.telemetry
  });

  // Cart Module
  const cartRepository = new CartRepository(redis, logger);
  const cartLockManager = new CartLockManager(redis, logger, redlockNodes);
  const cartMerger = new CartMerger(redis, logger, cartLockManager);
  const cartService = new CartService(cartRepository, cartLockManager, cartMerger, logger);
  
  const cartBreaker = new CircuitBreaker(async (fn: any) => await fn(), {
    timeout: 3000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
  });

  const cartController = new CartController(cartService, logger, cartBreaker);

  const cartRouter = createCartRouter({
    cartController,
    logger,
    authMiddleware: () => securityMiddleware.authenticate()
  });

  const outboxRelay = new OutboxRelayService(
    knexInstance,
    checkoutEventProducer,
    logger,
    parseInt(process.env.OUTBOX_BATCH_SIZE || '50', 10),
    parseInt(process.env.OUTBOX_INTERVAL_MS || '1000', 10)
  );

  return {
    userRouter,
    productRouter,
    orderRouter,
    cartRouter,
    outboxRelay
  };
};
