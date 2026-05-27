describe('config validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load config with defaults when required vars are set', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';

    let cfg:
      | {
          config: {
            port: unknown;
            databaseUrl: string;
            rateLimiter: {
              maxRequests: number;
              postgresTable: string;
              store: string;
              windowMs: number;
            };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.port).toBeDefined();
    expect(cfg!.config.databaseUrl).toContain('postgresql://');
    expect(cfg!.config.rateLimiter).toEqual({
      maxRequests: 5,
      postgresTable: 'gateway_rate_limit_buckets',
      store: 'memory',
      windowMs: 60_000,
    });
  });

  it('should expose configured persistent rate limiter settings', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
    process.env.RATE_LIMIT_STORE = 'postgres';
    process.env.RATE_LIMIT_MAX_REQUESTS = '25';
    process.env.RATE_LIMIT_WINDOW_MS = '15000';
    process.env.RATE_LIMIT_PG_TABLE = 'custom_gateway_limits';

    let cfg:
      | {
          config: {
            rateLimiter: {
              maxRequests: number;
              postgresTable: string;
              store: string;
              windowMs: number;
            };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.rateLimiter).toEqual({
      maxRequests: 25,
      postgresTable: 'custom_gateway_limits',
      store: 'postgres',
      windowMs: 15_000,
    });
  });

  it('should call process.exit(1) when required env vars are missing', async () => {
    // Remove fields that have no defaults — env.ts will fail to parse and call process.exit(1)
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_API_KEY;
    delete process.env.METRICS_API_KEY;

    const exitMock = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await jest.isolateModulesAsync(async () => {
      await import('./env.js');
    });

    expect(exitMock).toHaveBeenCalledWith(1);
    exitMock.mockRestore();
  });
});
