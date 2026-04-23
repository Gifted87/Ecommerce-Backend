require("dotenv").config();

if (process.env.NODE_ENV === 'production' && (!process.env.DB_HOST || process.env.DB_PASSWORD === 'postgres')) {
  throw new Error('FATAL: Production database credentials cannot use default or missing values.');
}

module.exports = {
  development: {
    client: "postgresql",
    connection: {
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432", 10),
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "ecommerce",
    },
    pool: {
      min: parseInt(process.env.DB_POOL_MIN || "2", 10),
      max: parseInt(process.env.DB_POOL_MAX || "20", 10),
    },
    migrations: {
      directory: [
        "./src/services/product/catalog_inventory_manager/migrations",
        "./src/services/user/auth_mfa_module/migrations",
        "./src/services/order/checkout_processor/migrations"
      ],
      extension: "ts",
    },
  },
};
