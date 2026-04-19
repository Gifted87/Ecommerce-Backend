import { Kafka, Producer, Consumer, EachMessagePayload } from 'kafkajs';
import Redis from 'ioredis';
import Opossum = require('opossum');
import { Logger } from 'pino';
import { z } from 'zod';
import { setTimeout } from 'timers/promises';

export enum WorkerState {
  BOOTSTRAP = 'BOOTSTRAP',
  READY = 'READY',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED',
}

export interface TaskDefinition {
  type: string;
  execute: (payload: any) => Promise<void>;
  retryPolicy: {
    maxRetries: number;
    baseDelayMs: number;
  };
}

export class BackgroundWorkerOrchestrator {
  private state: WorkerState = WorkerState.BOOTSTRAP;
  private readonly workers: Map<string, TaskDefinition> = new Map();
  // Use any to bypass TS namespace issue
  private readonly circuitBreaker: any;
  private consumer: Consumer | null = null;
  private producer: Producer | null = null;

  constructor(
    private readonly kafka: Kafka,
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly groupId: string
  ) {
    this.circuitBreaker = new Opossum(async (fn: () => Promise<any>) => await fn(), {
      timeout: 30000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    });

    this.setupLifecycleHooks();
  }

  private setupLifecycleHooks(): void {
    process.on('SIGTERM', async () => await this.shutdown());
    process.on('SIGINT', async () => await this.shutdown());
  }

  public registerTask(task: TaskDefinition): void {
    this.workers.set(task.type, task);
  }

  public async start(topics: string[]): Promise<void> {
    this.logger.info('Orchestrator initializing...');
    
    this.consumer = this.kafka.consumer({ groupId: this.groupId });
    this.producer = this.kafka.producer({ allowAutoTopicCreation: false });

    await this.consumer.connect();
    await this.producer.connect();

    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    this.state = WorkerState.READY;
    this.logger.info('Orchestrator READY.');

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => await this.handleMessage(payload),
    });

    this.state = WorkerState.RUNNING;
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    if (this.state !== WorkerState.RUNNING) return;

    const { message, topic } = payload;
    const rawData = message.value?.toString();
    if (!rawData) return;

    try {
      const data = JSON.parse(rawData);
      const task = this.workers.get(data.type);

      if (!task) {
        this.logger.warn({ taskType: data.type }, 'No handler registered for task type');
        return;
      }

      await this.executeWithRetry(task, data.payload);
    } catch (err) {
      this.logger.error({ err, topic }, 'Failed to process message');
      await this.moveToDLQ(payload);
    }
  }

  private async executeWithRetry(task: TaskDefinition, payload: any): Promise<void> {
    let attempts = 0;
    const { maxRetries, baseDelayMs } = task.retryPolicy;

    while (attempts <= maxRetries) {
      try {
        await this.circuitBreaker.fire(async () => await task.execute(payload));
        return;
      } catch (err) {
        attempts++;
        if (attempts > maxRetries) {
          this.logger.error({ err, taskType: task.type }, 'Max retries exceeded');
          throw err;
        }
        const delay = baseDelayMs * Math.pow(2, attempts - 1);
        await setTimeout(delay);
      }
    }
  }

  private async moveToDLQ(payload: EachMessagePayload): Promise<void> {
    if (!this.producer) return;
    try {
      await this.producer.send({
        topic: 'dead-letter-queue',
        messages: [{ value: payload.message.value }],
      });
    } catch (err) {
      this.logger.error({ err }, 'Critical failure: Could not move to DLQ');
    }
  }

  private async shutdown(): Promise<void> {
    if (this.state === WorkerState.STOPPING || this.state === WorkerState.STOPPED) return;
    
    this.state = WorkerState.STOPPING;
    this.logger.info('Orchestrator shutting down...');

    try {
      await this.consumer?.disconnect();
      await this.producer?.disconnect();
      await this.redis.quit();
    } catch (err) {
      this.logger.error({ err }, 'Error during shutdown');
    } finally {
      this.state = WorkerState.STOPPED;
      this.logger.info('Orchestrator STOPPED.');
      process.exit(0);
    }
  }
}
