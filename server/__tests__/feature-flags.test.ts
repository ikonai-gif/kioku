import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to re-import the module after setting env vars, so we use vi.resetModules()
// and dynamic imports inside each test where env manipulation is needed.

describe('feature-flags: flags object', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env = { ...origEnv };
    vi.resetModules();
  });

  it('all flags default to true when env vars are unset', async () => {
    delete process.env.MEETING_ROOM_ENABLED;
    delete process.env.LUCA_ENABLED;
    delete process.env.GMAIL_SEND_ENABLED;
    delete process.env.EMBEDDINGS_ENABLED;
    delete process.env.PUSH_ENABLED;
    vi.resetModules();
    const { flags } = await import('../feature-flags');
    expect(flags.MEETING_ROOM_ENABLED).toBe(true);
    expect(flags.LUCA_ENABLED).toBe(true);
    expect(flags.GMAIL_SEND_ENABLED).toBe(true);
    expect(flags.EMBEDDINGS_ENABLED).toBe(true);
    expect(flags.PUSH_ENABLED).toBe(true);
  });

  it('flag becomes false when env var set to "false"', async () => {
    process.env.MEETING_ROOM_ENABLED = 'false';
    vi.resetModules();
    const { flags } = await import('../feature-flags');
    expect(flags.MEETING_ROOM_ENABLED).toBe(false);
  });

  it('flag stays true when env var is "true"', async () => {
    process.env.LUCA_ENABLED = 'true';
    vi.resetModules();
    const { flags } = await import('../feature-flags');
    expect(flags.LUCA_ENABLED).toBe(true);
  });

  it('flag stays true when env var is "1"', async () => {
    process.env.GMAIL_SEND_ENABLED = '1';
    vi.resetModules();
    const { flags } = await import('../feature-flags');
    expect(flags.GMAIL_SEND_ENABLED).toBe(true);
  });

  it('flag stays true when env var is empty string ""', async () => {
    process.env.EMBEDDINGS_ENABLED = '';
    vi.resetModules();
    const { flags } = await import('../feature-flags');
    expect(flags.EMBEDDINGS_ENABLED).toBe(true);
  });

  it('flag stays true when env var is undefined', async () => {
    delete process.env.PUSH_ENABLED;
    vi.resetModules();
    const { flags } = await import('../feature-flags');
    expect(flags.PUSH_ENABLED).toBe(true);
  });

  it('each flag is independently controlled', async () => {
    process.env.MEETING_ROOM_ENABLED = 'false';
    process.env.LUCA_ENABLED = 'false';
    process.env.GMAIL_SEND_ENABLED = 'false';
    // Leave EMBEDDINGS_ENABLED and PUSH_ENABLED unset (should be true)
    delete process.env.EMBEDDINGS_ENABLED;
    delete process.env.PUSH_ENABLED;
    vi.resetModules();
    const { flags } = await import('../feature-flags');
    expect(flags.MEETING_ROOM_ENABLED).toBe(false);
    expect(flags.LUCA_ENABLED).toBe(false);
    expect(flags.GMAIL_SEND_ENABLED).toBe(false);
    expect(flags.EMBEDDINGS_ENABLED).toBe(true);
    expect(flags.PUSH_ENABLED).toBe(true);
  });
});

describe('feature-flags: requireFlag middleware', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    vi.resetModules();
  });

  it('calls next() when flag is enabled', async () => {
    delete process.env.MEETING_ROOM_ENABLED;
    vi.resetModules();
    const { requireFlag } = await import('../feature-flags');
    const middleware = requireFlag('MEETING_ROOM_ENABLED');

    const req = {} as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 503 when flag is disabled', async () => {
    process.env.LUCA_ENABLED = 'false';
    vi.resetModules();
    const { requireFlag } = await import('../feature-flags');
    const middleware = requireFlag('LUCA_ENABLED');

    const req = {} as any;
    const jsonFn = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json: jsonFn }) } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'feature_disabled',
        feature: 'LUCA_ENABLED',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('503 response includes message field', async () => {
    process.env.PUSH_ENABLED = 'false';
    vi.resetModules();
    const { requireFlag } = await import('../feature-flags');
    const middleware = requireFlag('PUSH_ENABLED');

    const req = {} as any;
    const jsonFn = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json: jsonFn }) } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('PUSH_ENABLED') })
    );
  });
});

describe('feature-flags: logFlags', () => {
  it('calls logger.info with flags object', async () => {
    vi.resetModules();
    const { logFlags, flags } = await import('../feature-flags');
    const mockLogger = { info: vi.fn() };
    logFlags(mockLogger);
    expect(mockLogger.info).toHaveBeenCalledOnce();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ flags }),
      '[feature-flags] initial state'
    );
  });
});
