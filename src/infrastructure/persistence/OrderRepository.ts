export interface OrderRepository {
  findByUser(userId: string, options: { page: number, limit: number, from?: Date, to?: Date }): Promise<any[]>;
}
