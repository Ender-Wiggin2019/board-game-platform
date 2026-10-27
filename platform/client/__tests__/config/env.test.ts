import { describe, expect, it, vi } from 'vitest';

describe('client debug route env defaults', () => {
  it('reads arbitrary host variables by name at runtime', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_FEATURE_RANKINGS', 'true');

    const { readClientEnv } = await import('../../src/config/env');

    expect(readClientEnv('VITE_FEATURE_RANKINGS')).toBe('true');
    expect(readClientEnv('VITE_UNKNOWN_VARIABLE')).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('uses relative same-origin defaults in development', async () => {
    vi.resetModules();

    const { resolveClientEnv } = await import('../../src/config/env');

    expect(
      resolveClientEnv({
        production: false,
        locationOrigin: 'http://localhost:5173',
      }),
    ).toEqual({
      VITE_API_URL: '/api',
      VITE_WS_URL: 'http://localhost:5173',
      VITE_ENABLE_DEBUG_ROUTES: false,
    });
  });

  it('uses production same-origin defaults and ignores deployment overrides', async () => {
    vi.resetModules();

    const { resolveClientEnv } = await import('../../src/config/env');

    expect(
      resolveClientEnv({
        production: true,
        apiUrl: 'not-a-url',
        wsUrl: 'not-a-url',
        enableDebugRoutes: 'true',
        locationOrigin: 'https://game.example.test/',
      }),
    ).toEqual({
      VITE_API_URL: '/api',
      VITE_WS_URL: 'https://game.example.test',
      VITE_ENABLE_DEBUG_ROUTES: false,
    });
  });

  it('requires the API env to include the /api REST namespace', async () => {
    vi.resetModules();

    const previousApiUrl = import.meta.env.VITE_API_URL;
    const previousWsUrl = import.meta.env.VITE_WS_URL;
    const previousEnableDebugRoutes = import.meta.env.VITE_ENABLE_DEBUG_ROUTES;

    import.meta.env.VITE_API_URL = 'http://localhost:3000';
    import.meta.env.VITE_WS_URL = 'http://localhost:3000';
    delete import.meta.env.VITE_ENABLE_DEBUG_ROUTES;

    await expect(import('../../src/config/env')).rejects.toThrow(
      /VITE_API_URL must include the \/api REST namespace/,
    );

    import.meta.env.VITE_API_URL = previousApiUrl;
    import.meta.env.VITE_WS_URL = previousWsUrl;
    import.meta.env.VITE_ENABLE_DEBUG_ROUTES = previousEnableDebugRoutes;
  });

  it('normalizes an existing /api REST namespace by trimming trailing slashes', async () => {
    vi.resetModules();

    const previousApiUrl = import.meta.env.VITE_API_URL;
    const previousWsUrl = import.meta.env.VITE_WS_URL;
    const previousEnableDebugRoutes = import.meta.env.VITE_ENABLE_DEBUG_ROUTES;

    import.meta.env.VITE_API_URL = 'https://game.example.test/api/';
    import.meta.env.VITE_WS_URL = 'https://game.example.test';
    delete import.meta.env.VITE_ENABLE_DEBUG_ROUTES;

    const { CLIENT_ENV } = await import('../../src/config/env');

    expect(CLIENT_ENV.VITE_API_URL).toBe('https://game.example.test/api');

    import.meta.env.VITE_API_URL = previousApiUrl;
    import.meta.env.VITE_WS_URL = previousWsUrl;
    import.meta.env.VITE_ENABLE_DEBUG_ROUTES = previousEnableDebugRoutes;
  });

  it('defaults debug routes to disabled when the env flag is absent', async () => {
    vi.resetModules();

    const previousApiUrl = import.meta.env.VITE_API_URL;
    const previousWsUrl = import.meta.env.VITE_WS_URL;
    const previousEnableDebugRoutes = import.meta.env.VITE_ENABLE_DEBUG_ROUTES;

    import.meta.env.VITE_API_URL = 'http://localhost:3000/api';
    import.meta.env.VITE_WS_URL = 'http://localhost:3000';
    delete import.meta.env.VITE_ENABLE_DEBUG_ROUTES;

    const { CLIENT_ENV } = await import('../../src/config/env');

    expect(CLIENT_ENV.VITE_ENABLE_DEBUG_ROUTES).toBe(false);

    import.meta.env.VITE_API_URL = previousApiUrl;
    import.meta.env.VITE_WS_URL = previousWsUrl;
    import.meta.env.VITE_ENABLE_DEBUG_ROUTES = previousEnableDebugRoutes;
  });

  it('rejects invalid websocket URLs and debug route flags', async () => {
    vi.resetModules();

    const previousApiUrl = import.meta.env.VITE_API_URL;
    const previousWsUrl = import.meta.env.VITE_WS_URL;
    const previousEnableDebugRoutes = import.meta.env.VITE_ENABLE_DEBUG_ROUTES;

    import.meta.env.VITE_API_URL = 'http://localhost:3000/api';
    import.meta.env.VITE_WS_URL = 'not-a-url';
    import.meta.env.VITE_ENABLE_DEBUG_ROUTES = 'sometimes';

    await expect(import('../../src/config/env')).rejects.toThrow(
      /VITE_WS_URL must be a valid URL/,
    );

    import.meta.env.VITE_API_URL = previousApiUrl;
    import.meta.env.VITE_WS_URL = previousWsUrl;
    import.meta.env.VITE_ENABLE_DEBUG_ROUTES = previousEnableDebugRoutes;
  });
});
