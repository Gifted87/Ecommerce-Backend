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

import { IUserRepository } from './user.repository';

/**
 * UserService handles the core business logic for user management within the system.
 * 
 * It manages user registration, profile retrieval, and updates, ensuring that
 * all password operations are handled securely through the SecurityService
 * and that data integrity is maintained through the UserRepository.
 */
export class UserService {
  /**
   * @param userRepository - The data access object for users.
   * @param securityService - Service for hashing and verifying passwords.
   * @param logger - The application's pino logger instance.
   */
  constructor(
    private readonly userRepository: IUserRepository,
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

    try {
      const createdUser = await this.userRepository.createUser(validated);
      this.logger.info({ userId: validated.user_id }, 'User registered successfully');
      return createdUser;
    } catch (error: any) {
      this.logger.error({ error: error.message, email: data.email }, 'Failed to register user');
      if (error.code === '23505' || error.message.includes('23505')) {
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
    try {
      const result = await this.userRepository.findById(userId);
      return result;
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
    try {
      if (!data.first_name && !data.last_name && !data.email) {
        const user = await this.findById(userId);
        if (!user) throw new Error('USER_NOT_FOUND');
        return user;
      }

      const updatedUser = await this.userRepository.updateUser(userId, data);
      this.logger.info({ userId }, 'User profile updated');
      return updatedUser;
    } catch (error: any) {
      this.logger.error({ error, userId }, 'Failed to update user profile');
      if (error.message === 'NOT_FOUND') {
        throw new Error('USER_NOT_FOUND');
      }
      throw new Error('USER_UPDATE_FAILED');
    }
  }
}
