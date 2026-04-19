import { Pool } from 'pg';
import { Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { SecurityService } from '../../../../shared/security/security.service';
import { 
  UserModel, 
  UserModelSchema, 
  UserRegistration, 
  UserUpdate 
} from '../types';

/**
 * UserService handles the core business logic for user management within the system.
 * 
 * It manages user registration, profile retrieval, and updates, ensuring that
 * all password operations are handled securely through the SecurityService
 * and that data integrity is maintained in the PostgreSQL database.
 */
export class UserService {
  private readonly tableName = 'users';

  /**
   * @param db - The PostgreSQL connection pool.
   * @param securityService - Service for hashing and verifying passwords.
   * @param logger - The application's pino logger instance.
   */
  constructor(
    private readonly db: Pool,
    private readonly securityService: SecurityService,
    private readonly logger: Logger
  ) {}

  /**
   * Registers a new user in the system.
   * 
   * This method hashes the user's password using Argon2id, generates a unique
   * UUID, and persists the user record. It also enforces email uniqueness.
   * 
   * @param data - The user registration details (email, password, etc.).
   * @returns A promise resolving to the newly created UserModel.
   * @throws Error (USER_ALREADY_EXISTS) if the email is already registered.
   * @throws Error (USER_REGISTRATION_FAILED) for other database errors.
   */
  async register(data: UserRegistration): Promise<UserModel> {
    const userId = uuidv4();
    const passwordHash = await this.securityService.hashPassword(data.password);

    const user: UserModel = {
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

    const validated = UserModelSchema.parse(user);

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

      if (result.rows.length === 0) {
        throw new Error('USER_REGISTRATION_FAILED: NO_DATA_RETURNED');
      }

      this.logger.info({ userId: validated.user_id }, 'User registered successfully');
      return this.mapRowToModel(result.rows[0]);
    } catch (error: any) {
      this.logger.error({ error: error.message, email: data.email }, 'Failed to register user');
      if (error.code === '23505') {
          throw new Error('USER_ALREADY_EXISTS');
      }
      throw new Error('USER_REGISTRATION_FAILED');
    }
  }

  /**
   * Retrieves a user profile from the database by their unique ID.
   * 
   * @param userId - The unique identifier of the user to fetch.
   * @returns A promise resolving to the UserModel if found, or null otherwise.
   * @throws Error (USER_FETCH_FAILED) if the database query fails.
   */
  async findById(userId: string): Promise<UserModel | null> {
    const query = `SELECT * FROM ${this.tableName} WHERE user_id = $1`;
    try {
      const result = await this.db.query(query, [userId]);
      if (result.rows.length === 0) return null;
      return this.mapRowToModel(result.rows[0]);
    } catch (error) {
      this.logger.error({ error, userId }, 'Failed to fetch user by ID');
      throw new Error('USER_FETCH_FAILED');
    }
  }

  /**
   * Updates an existing user's profile information.
   * 
   * Dynamically constructs the UPDATE query based on the fields provided in the data object.
   * 
   * @param userId - The unique identifier of the user to update.
   * @param data - The fields to update (first_name, last_name, email).
   * @returns A promise resolving to the updated UserModel.
   * @throws Error (USER_NOT_FOUND) if the user does not exist.
   * @throws Error (USER_UPDATE_FAILED) if the update operation fails.
   */
  async updateProfile(userId: string, data: UserUpdate): Promise<UserModel> {
    const fields: string[] = [];
    const values: any[] = [];
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
      if (!user) throw new Error('USER_NOT_FOUND');
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
      if (result.rows.length === 0) throw new Error('USER_NOT_FOUND');
      
      this.logger.info({ userId }, 'User profile updated');
      return this.mapRowToModel(result.rows[0]);
    } catch (error) {
      this.logger.error({ error, userId }, 'Failed to update user profile');
      throw new Error('USER_UPDATE_FAILED');
    }
  }

  /**
   * Maps a raw database row to the UserModel structure.
   * 
   * Handles JSON parsing for fields stored as strings in the database (e.g., roles).
   * 
   * @param row - The raw result row from the pg query.
   * @returns The mapped UserModel object.
   * @private
   */
  private mapRowToModel(row: any): UserModel {
    if (!row) throw new Error('MAPPING_FAILED: NO_ROW');
    return {
      ...row,
      roles: typeof row.roles === 'string' ? JSON.parse(row.roles) : row.roles,
    };
  }
}
