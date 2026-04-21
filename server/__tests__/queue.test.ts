import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock ioredis so tests never connect to a real Redis server.
// Must use 'function' (not arrow) for constructors.
vi.mock('ioredis', () => {
  const instances: any[] = [];
  function MockIORedis(this: any, _url: string, _opts: any) {
    this._pingResult = 'PONG';
    this.on = vi.fn();
    this.ping = vi.fn().mockImplementation(() => Promise.resolve(this._pingResult));
    this.quit = vi.fn().mockResolvedValue('OK');
    instances.push(this);
  }
  (MockIORedis as any)._instances = instances;
  return { default: MockIORedis };
});

// Mock bullmq Queue so we never touch real Redis.
vi.mock('bullmq', () => {
  function MockQueue(this: any, name: string, _opts: any) {
    this.name = name;
    this.close = vi.fn().mockResolvedValue(undefined);
  }
  return { Queue: MockQueue };
});

describe('QUEUE_NAMES constants', () => {
  beforeEach(() => { vi.resetModules(); });

  it('has expected meeting-turns value', async () => {
    const { QUEUE_NAMES } = await import('../queue');
    expect(QUEUE_NAMES.MEETING_TURNS).toBe('meeting-turns');
  });

  it('has expected luca-jobs value', async () => {
    const { QUEUE_NAMES } = await import('../queue');
    expect(QUEUE_NAMES.LUCA_JOBS).toBe('luca-jobs');
  });

  it('has expected memory-embedding value', async () => {
    const { QUEUE_NAMES } = await import('../queue');
    expect(QUEUE_NAMES.MEMORY_EMBEDDING).toBe('memory-embedding');
  });

  it('has exactly 3 queue names', async () => {
    const { QUEUE_NAMES } = await import('../queue');
    expect(Object.keys(QUEUE_NAMES)).toHaveLength(3);
  });
});

describe('getRedis', () => {
  const origEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('throws when REDIS_URL is empty string', async () => {
    process.env.REDIS_URL = '';
    const { getRedis } = await import('../queue');
    expect(() => getRedis()).toThrowError('REDIS_URL env var required for queue operations');
  });

  it('throws when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const { getRedis } = await import('../queue');
    expect(() => getRedis()).toThrowError('REDIS_URL env var required');
  });

  it('returns an IORedis instance when REDIS_URL is set', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { getRedis } = await import('../queue');
    const redis = getRedis();
    expect(redis).toBeDefined();
    expect(typeof redis.ping).toBe('function');
    expect(typeof redis.quit).toBe('function');
  });

  it('returns the same instance on repeated calls (singleton)', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { getRedis } = await import('../queue');
    const r1 = getRedis();
    const r2 = getRedis();
    expect(r1).toBe(r2);
  });
});

describe('pingRedis', () => {
  const origEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('returns true when Redis responds with PONG', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { pingRedis } = await import('../queue');
    const result = await pingRedis();
    expect(result).toBe(true);
  });

  it('returns false when REDIS_URL is empty (getRedis throws)', async () => {
    process.env.REDIS_URL = '';
    const { pingRedis } = await import('../queue');
    const result = await pingRedis();
    expect(result).toBe(false);
  });

  it('returns false when Redis ping rejects', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { getRedis, pingRedis } = await import('../queue');
    // Get the redis instance first, then override its ping to throw
    const redis = getRedis();
    (redis.ping as any).mockRejectedValueOnce(new Error('connection refused'));
    const result = await pingRedis();
    expect(result).toBe(false);
  });
});

describe('closeQueues', () => {
  const origEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('is a no-op (resolves without error) when no queues have been created', async () => {
    delete process.env.REDIS_URL;
    const { closeQueues } = await import('../queue');
    // Should resolve without throwing even though no Redis or queues exist
    await expect(closeQueues()).resolves.toBeUndefined();
  });

  it('closes all created queues and resets connection', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { getQueue, closeQueues, QUEUE_NAMES } = await import('../queue');
    const q = getQueue(QUEUE_NAMES.MEETING_TURNS);
    await closeQueues();
    expect(q.close).toHaveBeenCalledOnce();
  });
});

describe('getQueue', () => {
  const origEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('creates a queue with the given name', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { getQueue, QUEUE_NAMES } = await import('../queue');
    const q = getQueue(QUEUE_NAMES.LUCA_JOBS);
    expect(q.name).toBe('luca-jobs');
  });

  it('returns the same queue instance on repeated calls (lazy singleton)', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { getQueue, QUEUE_NAMES } = await import('../queue');
    const q1 = getQueue(QUEUE_NAMES.MEMORY_EMBEDDING);
    const q2 = getQueue(QUEUE_NAMES.MEMORY_EMBEDDING);
    expect(q1).toBe(q2);
  });

  it('creates different queues for different names', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const { getQueue, QUEUE_NAMES } = await import('../queue');
    const q1 = getQueue(QUEUE_NAMES.MEETING_TURNS);
    const q2 = getQueue(QUEUE_NAMES.LUCA_JOBS);
    expect(q1).not.toBe(q2);
    expect(q1.name).toBe('meeting-turns');
    expect(q2.name).toBe('luca-jobs');
  });
});
