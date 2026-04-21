import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import logger from './logger';

const REDIS_URL = process.env.REDIS_URL || '';

let connection: IORedis | null = null;

export function getRedis(): IORedis {
  if (!connection) {
    if (!REDIS_URL) {
      throw new Error('REDIS_URL env var required for queue operations');
    }
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null, // required for BullMQ
      enableReadyCheck: true,
    });
    connection.on('error', (err) => logger.error({ err: err.message }, '[redis] error'));
    connection.on('connect', () => logger.info('[redis] connected'));
  }
  return connection;
}

// Queue definitions — 3 queues per plan
export const QUEUE_NAMES = {
  MEETING_TURNS: 'meeting-turns',
  LUCA_JOBS: 'luca-jobs',
  MEMORY_EMBEDDING: 'memory-embedding',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

// Lazy queue creation — only when Redis is actually needed
const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 }, // keep 1h / 1000 jobs
        removeOnFail: { age: 86400 }, // keep failed jobs 24h for debugging
      } satisfies JobsOptions,
    });
    queues.set(name, q);
    logger.info({ queue: name }, '[bullmq] queue created');
  }
  return q;
}

/**
 * Close all queues and Redis connection — called from SIGTERM handler.
 * For producer-only setup (Week 2): near-instant close, no drain needed.
 * When workers are added (Week 3+): call worker.close() here for graceful job drain;
 * 30s timeout enforced by the SIGTERM handler in server/index.ts.
 */
export async function closeQueues(): Promise<void> {
  logger.info('[bullmq] closing queues...');
  await Promise.all(Array.from(queues.values()).map((q) => q.close()));
  if (connection) {
    await connection.quit();
    connection = null;
  }
  logger.info('[bullmq] closed');
}

/** Dummy job enqueue for health checks — returns true if Redis reachable */
export async function pingRedis(): Promise<boolean> {
  try {
    const redis = getRedis();
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}
