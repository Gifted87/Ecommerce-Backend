import { Logger } from 'pino';

/**
 * Interface representing a component that can be gracefully shut down.
 */
export interface GracefulShutdownComponent {
  name: string;
  shutdown: () => Promise<void>;
}

/**
 * LifecycleManager handles the graceful shutdown of the service.
 * It registers signal handlers, orchestrates component shutdown,
 * and enforces a safety timeout to prevent process hanging.
 */
export class LifecycleManager {
  private static instance: LifecycleManager;
  private readonly components: GracefulShutdownComponent[] = [];
  private isShuttingDown = false;
  private readonly logger: Logger;
  private readonly shutdownTimeoutMs: number;

  private constructor(logger: Logger, shutdownTimeoutMs: number = 30000) {
    this.logger = logger.child({ module: 'bootstrap/lifecycle' });
    this.shutdownTimeoutMs = shutdownTimeoutMs;
  }

  public static initialize(logger: Logger, shutdownTimeoutMs: number = 30000): LifecycleManager {
    if (!LifecycleManager.instance) {
      LifecycleManager.instance = new LifecycleManager(logger, shutdownTimeoutMs);
      LifecycleManager.instance.setupSignalHandlers();
    }
    return LifecycleManager.instance;
  }

  public static getInstance(): LifecycleManager {
    if (!LifecycleManager.instance) {
      throw new Error('LifecycleManager must be initialized before use.');
    }
    return LifecycleManager.instance;
  }

  /**
   * Registers a component for the shutdown sequence.
   */
  public registerComponent(component: GracefulShutdownComponent): void {
    this.components.push(component);
  }

  private setupSignalHandlers(): void {
    process.once('SIGTERM', () => this.handleShutdown('SIGTERM'));
    process.once('SIGINT', () => this.handleShutdown('SIGINT'));
  }

  private async handleShutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn({ signal }, 'Shutdown sequence already initiated, ignoring subsequent signal');
      return;
    }

    this.isShuttingDown = true;
    this.logger.info({ signal }, 'SIGNALS_RECEIVED: Starting graceful shutdown sequence');

    // Create a watchdog timer to force exit if components hang
    const timer = setTimeout(() => {
      this.logger.fatal('SHUTDOWN_TIMEOUT: Force exiting process due to timeout');
      process.exit(1);
    }, this.shutdownTimeoutMs);

    // Shutdown all components in reverse order of registration
    const componentsToShutdown = [...this.components].reverse();

    const results = await Promise.allSettled(
      componentsToShutdown.map(async (component) => {
        this.logger.info({ component: component.name }, 'Shutting down component');
        try {
          await component.shutdown();
          this.logger.info({ component: component.name }, 'Component shutdown complete');
        } catch (error) {
          this.logger.error({ component: component.name, error }, 'Error during component shutdown');
          throw error;
        }
      })
    );

    clearTimeout(timer);

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      this.logger.error({ failures: failures.length }, 'Some components failed to shut down gracefully');
      process.exit(1);
    }

    this.logger.info('SHUTDOWN_COMPLETE: Process exiting successfully');
    process.exit(0);
  }
}
