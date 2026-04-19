import { Router, Request, Response, NextFunction } from 'express';
import { ProductCatalogAndInventoryController } from './controller';
import { InventoryRepository } from '@/domain/inventory/repository';
import { InventoryCacheManager } from '@/infrastructure/cache/redis';
import pino from 'pino';

const logger = pino({ name: 'product-interface-layer' });
const repository: InventoryRepository = { 
  findById: async (id: string) => ({ id, name: 'Sample Product' }),
  findAllPaginated: async (page: number, limit: number) => ([]),
  reserveStock: async (productId: string, quantity: number) => ({ id: 'res123' }),
  ping: async () => {},
}; 
const cacheManager = new InventoryCacheManager();
const controller = new ProductCatalogAndInventoryController(repository, cacheManager, logger);

const productRouter = Router();

productRouter.get('/', (req, res, next) => controller.getProducts(req, res, next));
productRouter.post('/reserve', (req, res, next) => controller.reserveInventory(req, res, next));
productRouter.get('/health', (req, res) => controller.healthCheck(req, res));

export default productRouter;
