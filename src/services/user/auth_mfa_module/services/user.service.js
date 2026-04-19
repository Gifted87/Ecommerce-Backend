"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserService = void 0;
const uuid_1 = require("uuid");
const types_1 = require("../types");
/**
 * Handles the core business logic for user management within the system.
 *
 * This service is responsible for user registration, profile retrieval,
 * updates, and interacting with the underlying PostgreSQL persistence layer.
 * It ensures that passwords are securely hashed and user data adheres to the defined schema.
 */
class UserService {
    /**
     * @param db - The PostgreSQL connection pool.
     * @param securityService - Service for handling password hashing and verification.
     * @param logger - The application's pino logger instance.
     */
    constructor(db, securityService, logger) {
        this.db = db;
        this.securityService = securityService;
        this.logger = logger;
        this.tableName = 'users';
    }
    /**
     * Registers a new user in the system.
     *
     * Generates a unique UUID, hashes the provided password, and persists
     * the new user profile to the database.
     *
     * @param data - The registration details (email, password, etc.).
     * @returns The newly created user model.
     * @throws Error if registration fails or if validation constraints are violated.
     */
    async register(data) {
        const userId = (0, uuid_1.v4)();
        const passwordHash = await this.securityService.hashPassword(data.password);
        const user = {
            user_id: userId,
            email: data.email,
            password_hash: passwordHash,
            first_name: data.first_name,
            last_name: data.last_name,
            roles: ['USER'],
            is_active: true,
            mfa_enabled: false,
            mfa_secret: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        const validated = types_1.UserModelSchema.parse(user);
        const query = `
      INSERT INTO ${this.tableName} (
        user_id, email, password_hash, first_name, last_name, roles, is_active, mfa_enabled, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
        try {
            const result = await this.db.query(query, [
                validated.user_id,
                validated.email,
                validated.password_hash,
                validated.first_name,
                validated.last_name,
                JSON.stringify(validated.roles),
                validated.is_active,
                validated.mfa_enabled,
                validated.created_at,
                validated.updated_at,
            ]);
            this.logger.info({ userId: validated.user_id }, 'User registered successfully');
            return this.mapRowToModel(result.rows[0]);
        }
        catch (error) {
            this.logger.error({ error, email: data.email }, 'Failed to register user');
            throw new Error('USER_REGISTRATION_FAILED');
        }
    }
    /**
     * Retrieves a user profile from the database by their unique ID.
     *
     * @param userId - The unique identifier of the user.
     * @returns The user model if found, or null if no user matches the ID.
     * @throws Error if the database query fails.
     */
    async findById(userId) {
        const query = `SELECT * FROM ${this.tableName} WHERE user_id = $1`;
        try {
            const result = await this.db.query(query, [userId]);
            if (result.rows.length === 0)
                return null;
            return this.mapRowToModel(result.rows[0]);
        }
        catch (error) {
            this.logger.error({ error, userId }, 'Failed to fetch user by ID');
            throw new Error('USER_FETCH_FAILED');
        }
    }
    /**
     * Updates an existing user's profile information.
     *
     * @param userId - The unique identifier of the user to update.
     * @param data - The subset of profile fields to be updated.
     * @returns The updated user model.
     * @throws Error if the user is not found or the update operation fails.
     */
    async updateProfile(userId, data) {
        const fields = [];
        const values = [];
        let idx = 1;
        if (data.first_name) {
            fields.push(`first_name = $${idx++}`);
            values.push(data.first_name);
        }
        if (data.last_name) {
            fields.push(`last_name = $${idx++}`);
            values.push(data.last_name);
        }
        if (data.email) {
            fields.push(`email = $${idx++}`);
            values.push(data.email);
        }
        if (fields.length === 0) {
            const user = await this.findById(userId);
            if (!user)
                throw new Error('USER_NOT_FOUND');
            return user;
        }
        fields.push(`updated_at = $${idx++}`);
        values.push(new Date().toISOString());
        values.push(userId);
        const query = `
      UPDATE ${this.tableName}
      SET ${fields.join(', ')}
      WHERE user_id = $${idx}
      RETURNING *
    `;
        try {
            const result = await this.db.query(query, values);
            if (result.rows.length === 0)
                throw new Error('USER_NOT_FOUND');
            this.logger.info({ userId }, 'User profile updated');
            return this.mapRowToModel(result.rows[0]);
        }
        catch (error) {
            this.logger.error({ error, userId }, 'Failed to update user profile');
            throw new Error('USER_UPDATE_FAILED');
        }
    }
    /**
     * Internal helper to map a raw database row to the UserModel interface.
     *
     * @param row - The raw result row from PostgreSQL.
     * @returns A properly structured UserModel.
     * @private
     */
    mapRowToModel(row) {
        return {
            ...row,
            roles: typeof row.roles === 'string' ? JSON.parse(row.roles) : row.roles,
        };
    }
}
exports.UserService = UserService;
