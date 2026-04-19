import { AppOrchestrator } from './app_bootstrap/app';
import { config } from './app_bootstrap/config';
import logger from './shared/logger';

/**
 * @fileoverview Main Entry Point for the Ecommerce Backend.
 * Orchestrates the bootstrap sequence, initializes infrastructure, 
 * and starts the HTTP server.
 */

async function main() {
  const orchestrator = new AppOrchestrator();

  try {
    logger.info('Initializing application orchestrator...');
    await orchestrator.initialize();
    
    const context = orchestrator.getContext();
    const port = config.PORT || 3000;
    
    context.httpServer.listen(port, () => {
      logger.info({ port }, 'Application is up and running');
    });

  } catch (error) {
    logger.fatal({ error }, 'Failed to start application');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled rejection during startup:', error);
  process.exit(1);
});
