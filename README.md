# Complex Ecommerce Backend

A TypeScript and Express backend project organized around user, product, cart, and order workflows. The repository contains API routes, domain and service modules, and integrations for PostgreSQL, Redis, and Kafka.

This is an evolving project. The presence of security and reliability components in the source does not mean the application has been independently audited or is ready for production use.

## What is included

- Express application bootstrap and versioned API routes
- User authentication and MFA modules
- Product, cart, and order workflows
- PostgreSQL access and Knex migrations
- Redis-backed caching and rate-limiting components
- Kafka messaging and an outbox relay
- Structured logging and OpenTelemetry dependencies

The main server mounts the following route prefixes:

| Prefix | Area |
| --- | --- |
| `/api/v1/users` | User and authentication routes |
| `/api/v1/products` | Product routes |
| `/api/v1/orders` | Order routes |
| `/api/v1/cart` | Cart routes |
| `/health` | Database and Redis health check |

## Requirements

- Node.js 20 or later
- PostgreSQL
- Redis
- Kafka

Payment integrations and other external services may require additional credentials and configuration.

## Install and run

```bash
npm install
npm run build
npm start
```

The service reads configuration from environment variables and loads a local `.env` file when present. Review `src/app_bootstrap/config.ts`, the infrastructure modules, and the `.env.example` files before starting the server. Set service URLs, database credentials, and strong signing and encryption secrets for your own development environment. Never commit a real `.env` file or live credentials.

Useful package scripts:

```bash
npm run build
npm test
npm run lint
npm run migrate
```

The migration script uses Knex and requires a configured database. Redis and Kafka must also be available for full application startup.

## Repository layout

```text
src/
  api/              HTTP routes, controllers, and middleware
  app_bootstrap/    Application composition and server startup
  domain/           Domain types and schemas
  events/           Event handlers and dispatchers
  modules/          Feature modules
  services/         Application workflows
  shared/           Database, cache, messaging, logging, and security utilities
infra/              Infrastructure adapters
config/              Configuration support
```

## Security and project status

The code includes security-related components such as Helmet, validation, authentication middleware, rate limiting, password hashing, and MFA. Their existence does not establish that every route is protected or that the system is safe for real customer or payment data. Review configuration defaults, authorization coverage, database rules, and service credentials before exposing an instance to a network.

The package declares `UNLICENSED`; no open-source license is provided. All rights remain with the author unless a license is added.
