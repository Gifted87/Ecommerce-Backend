# Complex Ecommerce Backend - Comprehensive Technical Documentation

## 1. Introduction & Project Vision

The **Complex Ecommerce Backend** is a high-availability, production-ready microservice designed to handle the demanding requirements of modern digital commerce. Built with a focus on **security**, **resilience**, and **observability**, it provides a robust foundation for building scalable ecommerce platforms.

In the fast-paced world of digital commerce, downtime or data inconsistency can lead to significant financial loss and brand damage. This project addresses these challenges by implementing industry-leading architectural patterns and security standards. From the moment a user registers to the final order placement, every operation is designed with fault tolerance and data integrity in mind.

### Core Objectives
*   **Architectural Excellence**: Adhere to Clean Architecture and Domain-Driven Design (DDD) to ensure long-term maintainability.
*   **Security by Design**: Implement state-of-the-art cryptography and authentication mechanisms.
*   **Systemic Resilience**: Protect the system from cascading failures using the Circuit Breaker pattern.
*   **Operational Transparency**: Provide deep visibility into system performance through structured logging and metrics.
*   **Scalability**: Ensure the system can scale both vertically and horizontally by leveraging efficient infrastructure like Redis and Kafka.

---

## 2. Architectural Deep Dive

The system is architected using **Clean Architecture** (also known as Onion Architecture) and **Domain-Driven Design (DDD)** principles. This ensures that the core business logic—the "Domain"—remains pure and decoupled from technical details like the database, web framework, or external message bus.

### 2.1 The Layers of Clean Architecture
The codebase is structured into four distinct layers, with dependencies always pointing inwards toward the domain:

1.  **Domain Layer (`src/domain`)**: This is the heart of the application. It contains pure business entities, value objects, and domain services. It has NO dependencies on any external libraries (except perhaps utility ones like Zod for schema definition). This layer represents the business rules that remain constant regardless of the technology stack.
2.  **Service Layer (`src/services`)**: This layer orchestrates complex workflows. It uses domain entities and calls upon "Interface Adapters" (repositories, publishers) to perform its duties. For example, the `CheckoutProcessorService` coordinates between the `OrderRepository` and the `PaymentService` to complete an order.
3.  **Interface Layer (`src/api`)**: This layer handles communication with the outside world. It contains Express.js routers, controllers, and middleware. It is responsible for translating HTTP requests into domain-friendly formats and mapping domain results back to HTTP responses.
4.  **Infrastructure Layer (`src/shared`, `src/app_bootstrap`)**: This layer implements the technical details. It contains the actual implementations for database access (PostgreSQL), caching (Redis), messaging (Kafka), and security services.

### 2.2 Domain-Driven Design (DDD) Strategy
We use DDD to manage the complexity of the ecommerce domain by dividing it into **Bounded Contexts**:

*   **User Context**: Manages the identity, authentication, and authorization of users. It handles the "User" aggregate, which includes profiles and security credentials.
*   **Product Context**: Manages the catalog of products and their real-time inventory levels. The "Product" and "Inventory" are the core aggregates here.
*   **Cart Context**: Manages transient shopping carts. This is a high-velocity context where performance and concurrency are paramount.
*   **Order Context**: Manages the lifecycle of an order. The "Order" aggregate is the most complex, involving state transitions and distributed steps.

### 2.3 Separation of Concerns
Cross-cutting concerns like logging, security, and metrics are handled via **Middleware** and **Interceptors**. This prevents the business logic from being "polluted" with infrastructure code. For instance, authentication is handled by a dedicated middleware before a request ever reaches a controller.

---

## 3. Security Architecture & Cryptography

Security is not an afterthought in this system; it is baked into every layer. We follow the principle of **Defense in Depth**.

### 3.1 Password Hashing with Argon2id
The system uses **Argon2id**, the winner of the Password Hashing Competition (PHC), for all password operations. Unlike BCrypt or SCrypt, Argon2id is specifically designed to be resistant to GPU and ASIC-based cracking attacks. 

We configure Argon2id with:
*   **Memory Cost**: 64MB (high enough to hinder mass cracking but low enough for standard server response times).
*   **Time Cost**: 3 iterations.
*   **Parallelism**: 1 degree.
*   **Application-Level Pepper**: A secret string stored in the environment variables that is appended to every password before hashing. This provides an additional layer of security even if the database is compromised.

### 3.2 Data-at-Rest Encryption with AES-256-GCM
Sensitive user data (like MFA secrets or potentially PII) is encrypted before being stored in the database. We use **AES-256-GCM** (Galois/Counter Mode).

**Why GCM?**
GCM is an **Authenticated Encryption** mode. It provides both **Confidentiality** (the data is hidden) and **Integrity** (we can detect if the encrypted data has been tampered with). It produces a 16-byte authentication tag that must be verified during decryption.

**Key Management**:
We use a 32-byte (256-bit) Master Key. For every encryption operation, a unique 12-byte **Initialization Vector (IV)** is generated, ensuring that the same plaintext encrypted twice will result in different ciphertexts.

### 3.3 Multi-Factor Authentication (MFA)
The system supports **TOTP (Time-based One-Time Password)** MFA.
1.  **Enabling MFA**: The user is presented with a QR code (generated via `qrcode`) which they scan into an app like Google Authenticator or Authy.
2.  **Verification**: The system uses the `otplib` library to verify the 6-digit code against the encrypted secret stored in the database.
3.  **Security**: MFA secrets are encrypted with AES-256-GCM before storage.

### 3.4 Rate Limiting & Brute Force Protection
We implement multi-layered rate limiting using Redis:
*   **Account-Based (Email)**: Prevents brute-force or credential-stuffing attacks on a specific user account.
*   **Active Status Enforcement**: Beyond credential verification, the system enforces strict `is_active = true` lookups during every authentication attempt and token refresh, ensuring administratively suspended users are locked out immediately.
*   **Infrastructure Identity**: Configured with `app.set('trust proxy', 1)` to ensure correct client IP unmasking behind load balancers and proxies, critical for accurate rate limiting and audit trails.
*   **Redis Implementation**: Uses the `INCR` and `PEXPIRE` commands in a single atomic transaction (`MULTI`/`EXEC`) to track attempts within a rolling 60-second window.

---

## 4. Resilience & Fault Tolerance Strategy

In a distributed environment, failures are inevitable. The system is designed to "fail gracefully."

### 4.1 The Circuit Breaker Pattern (Opossum)
Every external dependency is wrapped in a circuit breaker. This prevents a failure in one system (e.g., the database) from overwhelming the entire application.

**The Three States**:
1.  **Closed**: Normal operation. Requests flow through to the dependency.
2.  **Open**: The dependency has failed more than the threshold (e.g., 50% failure rate). Requests are immediately rejected with a "Short-circuit" error, allowing the system to fail fast and saving resources.
3.  **Half-Open**: After a cooldown period (e.g., 30 seconds), the breaker allows a single "trial" request. If it succeeds, the breaker closes. If it fails, it returns to the Open state.

### 4.2 Graceful Shutdown Orchestration
The `AppOrchestrator` implements a robust signal handling mechanism (`SIGTERM`, `SIGINT`). When a shutdown signal is received:
1.  **HTTP Server Stop**: We stop accepting new HTTP requests immediately.
2.  **In-Flight Requests**: We allow a 30-second window for current requests to finish.
3.  **Infrastructure Teardown**: Components are shut down in the **reverse order** of their initialization. This ensures that a component like the `OrderService` still has its database and message bus connections available until it is finished shutting down.
4.  **Resource Cleanup**: All pools (PostgreSQL), clients (Redis), and producers/consumers (Kafka) are disconnected cleanly to avoid hung processes or "stale" connections on the server.

### 4.3 Error Handling & Compensation
The system uses a custom Error Hierarchy:
*   **DomainError**: Business rule violations (e.g., "Insufficient Stock").
*   **InfrastructureError**: Technical failures (e.g., "Database Timeout").
*   **APIError**: Client-side errors (e.g., "Validation Failed").

**Compensating Transactions**:
In complex workflows like `Checkout`, if a step fails (e.g., payment succeeds but inventory reservation fails), the system triggers compensation logic (e.g., marking the order as `FAILED` and logging the need for a manual refund or automated rollback) to ensure the system remains in a consistent state.

---

## 5. Module Deep Dives

### 5.1 The Cart Module & Distributed Concurrency
Shopping carts are high-velocity data structures. To ensure performance and consistency, we use:
*   **Redis as Primary Store**: Carts are stored as JSON-serialized objects in Redis, keyed by `userId`.
*   **Distributed Locking (Redlock)**: We implement a robust distributed lock using the Redlock algorithm.
    *   **Consensus-Based Safety**: In production, the system requires `REDIS_REDLOCK_NODES` to be configured with ≥3 independent Redis primaries to provide split-brain protection.
    *   **Fallback Strategy**: If fewer than 3 nodes are provided, the system logs a prominent warning and falls back to single-node locking, suitable for development but not for HA failover scenarios.
*   **Cart Merging Strategy**: When a user logs in, we merge their "guest cart" (stored in a temporary session) with their "user cart" (stored against their ID). The logic handles duplicate SKUs by summing quantities and ensuring price consistency.

### 5.2 The Product & Inventory Module
This module handles the product catalog and real-time stock levels.
*   **Inventory Processor**: Orchestrates stock mutations using a three-phase approach:
    1.  **PostgreSQL Update**: Atomically update the `total_stock` in the DB.
    2.  **Redis Invalidation**: Delete the cached inventory level to force a re-read on the next request.
    3.  **Kafka Publication**: Publish an `inventory.mutations` event to notify other services (like Search or Notifications).
*   **Concurrency Control**: Uses `SELECT FOR UPDATE` in PostgreSQL during stock adjustments to prevent race conditions (overselling) in high-traffic scenarios.

### 5.3 The Order & Checkout Module
The Order module uses a **State Machine** to manage the order lifecycle.
*   **States**: `PENDING`, `PROCESSING`, `PLACED`, `FAILED`, `SHIPPED`, `DELIVERED`, `CANCELLED`.
*   **Transition Engine**: Enforces strict rules on which states can move to others (e.g., an order cannot move from `CANCELLED` to `SHIPPED`).
*   **Checkout Workflow**: A resilient orchestration of:
    1.  Validating the input.
    2.  Setting state to `PROCESSING`.
    3.  Processing payment via a third-party gateway (with its own circuit breaker).
    4.  Publishing an `OrderPlaced` event.
    5.  Setting state to `PLACED`.

### 5.4 Detailed Inventory Reservation Lifecycle
The inventory reservation is a critical path for ensuring we never oversell. The process follows a strict sequence:
1.  **API Validation**: The `ProductController` receives a reservation request. It validates the `productId` and `quantity` using a Zod schema. It also checks for an `X-Idempotency-Key` to prevent double-reservation on network retries.
2.  **Service Delegation**: The `InventoryProcessor` receives the request. It wraps the operation in three independent circuit breakers (DB, Cache, Kafka).
3.  **Atomic DB Mutation**: Inside a Knex transaction, we perform a `SELECT FOR UPDATE` on the inventory row. This locks the row for the duration of the transaction and ensures the check-and-decrement operation is atomic at the database level.
4.  **Transactional Outbox**: Instead of a "dual-write" which is prone to partial failures, the event payload is written to an `outbox_events` table within the same ACID transaction as the stock decrement.
5.  **Event Relay**: A background `OutboxRelayService` polls the outbox using `SELECT ... FOR UPDATE SKIP LOCKED` to publish events to Kafka with at-least-once delivery guarantees.
6.  **Cache Invalidation**: After the DB confirms the mutation, we trigger a circuit-breaker protected invalidation of the `inventory:{productId}` key in Redis.

---

## 6. Testing & Quality Assurance

A complex system requires a comprehensive testing strategy. We employ a three-tier approach:

### 6.1 Unit Testing (Jest)
Unit tests focus on individual functions and classes in isolation.
*   **Domain Logic**: 100% coverage for the Order state machine and security services.
*   **Mocks**: We use `jest-mock-extended` to mock external dependencies like the DB pool or Redis client, ensuring tests are fast and deterministic.
*   **Location**: `src/**/*.test.ts` (alongside the source code).

### 6.2 Integration Testing
Integration tests verify the interaction between the application and its real infrastructure.
*   **Test Containers**: We use `testcontainers` or a dedicated test Docker environment to run a real PostgreSQL and Redis instance for these tests.
*   **Repository Tests**: Ensuring our Knex queries correctly interact with the DB schema and handle constraints (e.g., uniqueness, foreign keys).
*   **Kafka Tests**: Verifying that events are correctly produced and can be consumed by a test consumer.

### 6.3 End-to-End (E2E) Testing
E2E tests simulate real user journeys through the API.
*   **Supertest**: We use `supertest` to hit the actual Express routes and verify the end-to-end flow from the HTTP request to the database state change.
*   **Scenarios**: "User registration -> Login -> Add to Cart -> Checkout -> Order Confirmation".

---

## 7. Deployment & CI/CD Strategy

The project is designed to be "cloud-native" and containerized.

### 7.1 Dockerization
The `Dockerfile` uses a multi-stage build to minimize the final image size:
1.  **Build Stage**: Uses `node:20-alpine` to install all dependencies (including devDependencies) and compile the TypeScript code.
2.  **Runtime Stage**: Uses a clean `node:20-alpine` image and only copies the `dist` folder and production `node_modules`. This reduces the attack surface and image size (typically < 150MB).

### 7.2 Kubernetes (K8s) Orchestration
The system is ready for deployment to a K8s cluster.
*   **Deployments**: Separate deployments for the API and the Kafka consumers.
*   **Services**: ClusterIP services for internal communication and an Ingress for public API access.
*   **ConfigMaps & Secrets**: Management of environment variables and sensitive credentials (JWT secrets, DB passwords).
*   **Liveness & Readiness Probes**: Integrated with the `/health` endpoint to allow K8s to automatically restart unhealthy pods or stop routing traffic to initializing ones.

### 7.3 CI/CD Pipeline (GitHub Actions / GitLab CI)
A typical pipeline for this project includes:
1.  **Linting**: Running `eslint` to ensure code style consistency.
2.  **Type Checking**: Running `tsc --noEmit` to catch any TypeScript errors.
3.  **Testing**: Running the full test suite (Unit + Integration).
4.  **Security Scanning**: Running `npm audit` and static analysis tools (like Snyk or SonarQube) to detect vulnerabilities.
5.  **Build & Push**: Building the Docker image and pushing it to a private container registry (e.g., ECR, GCR).
6.  **Deploy**: Updating the K8s deployment using `helm` or `kubectl`.

---

## 8. Performance Optimization Techniques

To handle high traffic, we've implemented several optimizations:
*   **Connection Pooling**: Fine-tuned Knex and ioredis pools to prevent exhaustion during spikes.
*   **Serialization**: Using `JSON.stringify/parse` efficiently and considering Protocol Buffers for high-throughput Kafka topics.
*   **Asynchronous Processing**: Moving non-critical tasks (like sending emails or updating analytics) out of the main request-response cycle and into Kafka consumers.
*   **Pagination**: All listing APIs (Products, Orders) are paginated by default using `limit` and `offset` to prevent memory issues and slow queries.
*   **Indexing Strategy**: Regular analysis of query plans using `EXPLAIN ANALYZE` to ensure indexes are being utilized correctly.

---

## 9. Contributing & Code Standards

We follow strict coding standards to maintain quality:
*   **Clean Code**: Small, focused functions. Descriptive naming. No "Magic Numbers".
*   **Documentation**: All public functions and classes MUST have JSDoc comments.
*   **Commit Messages**: We follow Conventional Commits (e.g., `feat: add mfa support`, `fix: resolve race condition in cart`).

---

## 10. Infrastructure & Operations

### 10.1 Database Management (PostgreSQL & Knex)
We use **Knex.js** as our sole query builder and migration engine.
*   **Pool Consolidation**: To prevent PostgreSQL connection exhaustion, the system maintains a single global connection pool. Parallel ORMs (like Prisma) are strictly forbidden to ensure deterministic connection lifecycle management.
*   **Migrations**: All schema changes are version-controlled in the respective module `migrations` directories. This ensures that every environment (Dev, Staging, Prod) has the exact same schema.
*   **Indexes**: We use B-Tree indexes for primary and foreign keys, and Partial Indexes for the Outbox Pattern (targeting unprocessed events) to maximize performance.
*   **Database-Level Pagination**: Listing APIs utilize SQL-level `LIMIT` and `OFFSET` to ensure memory safety even with millions of records.
*   **Concurrency**: Critical row updates use `FOR UPDATE` locking to maintain integrity in distributed environments.

### 10.2 Messaging Strategy (Kafka)
Kafka is the backbone of our **Event-Driven Architecture**, orchestrated via the **Transactional Outbox Pattern**.
*   **Atomicity via Outbox**: The system avoids the "Dual-Write" anti-pattern. Domain changes and event payloads are committed in a single PostgreSQL transaction.
*   **Outbox Relay Service**: A dedicated background process polls the `outbox_events` table and publishes to Kafka. This ensures that if the message bus is down, events are safely stored and retried until delivery is confirmed.
*   **Idempotent Producers**: Our Kafka producers are configured for idempotency, ensuring that even in the case of network retries, a message is never duplicated on the broker.
*   **Consumer Groups**: Services are organized into consumer groups, allowing for horizontal scaling of message processing.
*   **Correlation IDs**: Every Kafka message header includes a `correlationId`, allowing us to trace a single user request across multiple asynchronous services.

### 10.3 Observability (Logging & Metrics)
*   **Structured Logging**: We use **Pino**. Logs are output in JSON format, which is easily parsed by log aggregators like ELK (Elasticsearch, Logstash, Kibana) or Datadog.
*   **PII Redaction**: The logger is configured to automatically redact sensitive fields like `password`, `email`, `credit_card`, and `shipping_address` before they are written to disk.
*   **Prometheus Metrics**: We use `prom-client` to track:
    *   **HTTP Metrics**: Request duration histograms and status code counters.
    *   **Infrastructure Metrics**: Database pool size and Redis connection status.
    *   **Business Metrics**: Orders placed, total revenue (tracked via events).

---

## 11. Getting Started: Developer Guide

### 11.1 Prerequisites
*   **Node.js**: Version 20.x or higher is required.
*   **Docker**: Recommended for running the infrastructure (DB, Redis, Kafka).
*   **NPM**: Version 9.x or higher.

### 11.2 Installation
1.  Clone the repository.
2.  Install dependencies: `npm install`.
3.  Set up environment variables: `cp .env.example .env`.

### 11.3 Infrastructure Setup (using Docker Compose)
```bash
docker-compose up -d
```
This will start PostgreSQL, Redis, and a single-node Kafka cluster (including Zookeeper).

### 11.4 Running the Application
*   **Development**: `npm run dev` (starts the server with `ts-node-dev` for auto-reloading).
*   **Production**:
    1.  `npm run build` (compiles TypeScript to JavaScript in the `dist` folder).
    2.  `npm run start` (starts the compiled application).

### 11.5 Testing
*   **Unit Tests**: `npm run test` (uses Jest).
*   **Integration Tests**: `npm run test:integration` (requires running infrastructure).
*   **Coverage**: `npm run test:coverage` (generates an LCOV report).

---

## 12. Summary of Technical Excellence

This project demonstrates a commitment to the highest standards of software engineering. By combining:
*   **TypeScript** for type-safety and developer productivity.
*   **Clean Architecture** for long-term maintainability.
*   **Advanced Cryptography** for user data protection.
*   **Fault-Tolerant Patterns** for extreme reliability.
*   **Event-Driven Communication** for scalability.

The **Complex Ecommerce Backend** provides a rock-solid foundation for any modern ecommerce enterprise. Its modular design allows it to start as a monolithic service and easily evolve into a suite of microservices as business needs grow.

---
*(Documentation generated and polished by ProCoder Agent - v1.0)*
