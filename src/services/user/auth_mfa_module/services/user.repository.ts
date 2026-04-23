import { Pool } from 'pg';
import { Logger } from 'pino';
import { UserModel, UserUpdate } from '../types';

export interface IUserRepository {
  createUser(user: UserModel): Promise<UserModel>;
  findById(userId: string): Promise<UserModel | null>;
  updateUser(userId: string, data: UserUpdate): Promise<UserModel>;
}

export class UserRepository implements IUserRepository {
  private readonly tableName = 'users';

  constructor(private readonly db: Pool, private readonly logger: Logger) {}

  async createUser(user: UserModel): Promise<UserModel> {
    const query = `
      INSERT INTO ${this.tableName} (
        user_id, email, password_hash, first_name, last_name, roles, is_active, mfa_enabled, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;

    const result = await this.db.query(query, [
      user.user_id,
      user.email,
      user.password_hash,
      user.first_name,
      user.last_name,
      JSON.stringify(user.roles),
      user.is_active,
      user.mfa_enabled,
      user.created_at,
      user.updated_at,
    ]);

    if (result.rows.length === 0) {
      throw new Error('NO_DATA_RETURNED');
    }

    return this.mapRowToModel(result.rows[0]);
  }

  async findById(userId: string): Promise<UserModel | null> {
    const query = `SELECT * FROM ${this.tableName} WHERE user_id = $1`;
    const result = await this.db.query(query, [userId]);
    if (result.rows.length === 0) return null;
    return this.mapRowToModel(result.rows[0]);
  }

  async updateUser(userId: string, data: UserUpdate, updatedAt: string = new Date().toISOString()): Promise<UserModel> {
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
       throw new Error('No fields to update');
    }

    fields.push(`updated_at = $${idx++}`);
    values.push(updatedAt);
    values.push(userId);

    const query = `
      UPDATE ${this.tableName}
      SET ${fields.join(', ')}
      WHERE user_id = $${idx}
      RETURNING *
    `;

    const result = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('NOT_FOUND');
    
    return this.mapRowToModel(result.rows[0]);
  }

  private mapRowToModel(row: any): UserModel {
    if (!row) throw new Error('MAPPING_FAILED: NO_ROW');
    return {
      ...row,
      roles: typeof row.roles === 'string' ? JSON.parse(row.roles) : row.roles,
    };
  }
}
