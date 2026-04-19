# Architecture Breakdown

This document provides a recursive breakdown of the project architecture.

## Root Level
- `src/`: Core application source code.
- `dist/`: Compiled JavaScript output (generated).
- `config/`: Application configuration files.
- `shared/`: Shared utilities, services, and middleware.
- `infra/`: Infrastructure definitions (e.g., database, CI/CD).
- `node_modules/`: Installed dependencies.

## Module: Services (`src/services/`)

### 1. `cart/` (Shopping Cart Service)
- Manages shopping carts and session-based interactions.
- `manager/`: Core logic, repository, and controller for the cart service.
  - `cart.controller.ts`: Handles HTTP requests for cart operations.
  - `cart.errors.ts`: Defines domain-specific errors for the cart service.
  - `cart.lock.manager.ts`: Manages distributed locks for concurrency control.
  - `cart.merger.ts`: Logic for merging guest carts into user carts.
  - `cart.repository.ts`: Handles data persistence for carts.
  - `cart.schema.ts`: Validation schemas for cart operations.
  - `cart.service.ts`: Primary business logic for cart management.
  - `cart.types.ts`: TypeScript definitions for the cart module.
  - `index.ts`: Entry point for the cart module.

### 2. `order/` (Order Processing Service)
- Manages customer orders, payment processing, and order history.
- `checkout_processor/`: Handles order checkout workflows.
  - `core/`: Manages order state.
    - `OrderStateManager.ts`: Manages and persists order state transitions.
  - `infrastructure/`: Infrastructure dependencies.
    - `events/`: Event producers.
      - `CheckoutEventProducer.ts`: Publishes order lifecycle events to Kafka.
    - `lock/`: Distributed locking mechanism.
      - `DistributedLockService.ts`: Mutex locking mechanism using Redis.
  - `logic/`: Business logic.
    - `OrderTransitionEngine.ts`: Logic for validating and processing order state transitions.
  - `migrations/`: Database migrations for orders.
    - `20260406000000_create_orders.ts`: Database schema migration.
  - `repository/`: Data persistence.
    - `orderRepository.ts`: CRUD operations for order data.
  - `service/`: Service logic.
    - `CheckoutProcessorService.ts`: Entry point for checkout processing.
  - `types/`: Domain types.
    - `order_types.ts`: Domain types for order-related operations.
  - `validation/`: Validation logic.
    - `checkout_validator.ts`: Validates checkout requests.

### 3. `product/` (Product Catalog Service)
- Manages product catalog and inventory.
- `catalog_inventory_manager/`: Core logic for managing catalog and inventory.
  - `bootstrap/`: Application initialization and infrastructure setup.
    - `config/`: `envConfig.ts`.
    - `health/`: `healthMonitor.ts`.
    - `infrastructure/`: `cache/redis.client.ts`, `database/databaseModule.ts`, `database/databaseService.ts`, `messaging/KafkaMessagingManager.ts`.
    - `lifecycle/`: `lifecycleManager.ts`.
    - `logging/`: `logger.ts`.
    - `orchestrator/`: `serviceOrchestrator.ts`.
    - `resilience/`: `circuitBreakerFactory.ts`.
    - `workers/`: `backgroundWorkerOrchestrator.ts`.
  - `controllers/`: Handles HTTP requests for catalog and inventory.
  - `infrastructure/`: Infrastructure components (cache, database, messaging).
  - `migrations/`: Database schema migrations.
  - `repositories/`: Data persistence for catalog and inventory.
  - `schemas/`: Validation schemas.
  - `services/`: Core business logic services (reconciliation).

### 4. `user/` (User Management Service)
- Manages user accounts, authentication, and MFA.
- `auth_mfa_module/`: Authentication and MFA logic.
  - `controllers/`:
    - `auth.controller.ts`:
      - Purpose: Handles HTTP requests for user authentication (login) and session refreshing. Uses `AuthService` to verify credentials and manage session states.
      - Contribution: Acts as the HTTP interface for authentication, enforcing input validation and mapping business service responses to API responses.
  - `services/`:
    - `auth.service.ts`: (See purpose/contribution above).
    - `mfa.service.ts`: (See purpose/contribution above).
    - `user.service.ts`: (See purpose/contribution above).

## Shared Modules (`src/shared/`)
- Contains shared utilities, services, and middleware.
