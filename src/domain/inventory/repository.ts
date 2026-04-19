export class InsufficientStockError extends Error {}
export class InventoryRepositoryError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface InventoryRepository {
  findById(id: string): Promise<any>;
  findAllPaginated(page: number, limit: number): Promise<any>;
  reserveStock(productId: string, quantity: number): Promise<any>;
  ping(): Promise<void>;
}
