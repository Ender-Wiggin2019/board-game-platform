import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let reporter: typeof import('@/lib/crashReporter');
const fetchMock = vi.fn();
function receipt(_url: string, init: RequestInit) {
  return Promise.resolve({
    ok: true,
    json: async () => ({ id: JSON.parse(String(init.body)).eventId }),
  });
}

beforeEach(async () => {
  vi.resetModules();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/auth?token=private#password');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(receipt);
  reporter = await import('@/lib/crashReporter');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('crash reporting', () => {
  it('automatically uploads stack and release context to the first-party API without credentials', async () => {
    const error = new TypeError('Cannot read AuthPage');
    error.stack =
      'TypeError: Cannot read AuthPage\n at https://site.test/main.js?token=private#secret:1:2';
    const incident = reporter.captureCrash(error, {
      source: 'route',
      componentStack: 'at AuthPage',
    });
    await incident.submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/platform/feedback/client-crash');
    expect(init.credentials).toBe('omit');
    const payload = JSON.parse(init.body);
    expect(payload).toMatchObject({
      source: 'route',
      message: 'Cannot read AuthPage',
      componentStack: 'at AuthPage',
      url: 'http://localhost:3000/auth',
    });
    expect(payload.stack).toContain('https://site.test/main.js');
    expect(init.body).not.toContain('private');
    expect(incident.getSnapshot()).toEqual({
      status: 'sent',
      reportId: payload.eventId,
    });
  });

  it('coalesces concurrent automatic/manual reports and duplicates across reloads', async () => {
    const error = new Error('same failure');
    const incident = reporter.captureCrash(error, { source: 'window' });
    expect(reporter.captureCrash(error, { source: 'react' })).toBe(incident);
    await Promise.all([incident.submit(), incident.submit()]);
    vi.resetModules();
    reporter = await import('@/lib/crashReporter');
    const restored = reporter.captureCrash(error, { source: 'route' });
    await restored.submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(restored.getSnapshot()).toEqual(incident.getSnapshot());
  });

  it('coalesces one error across resource, bootstrap and route sources', async () => {
    const error = {
      name: 'Error',
      message: 'same failure',
      stack:
        'Error: same failure\n    at http://localhost:3000/assets/main.js:1:2',
    };
    const resource = reporter.captureCrash(error, { source: 'resource' });
    const bootstrap = reporter.captureCrash(error, { source: 'bootstrap' });
    const route = reporter.captureCrash(error, { source: 'route' });

    expect(bootstrap).toBe(resource);
    expect(route).toBe(resource);

    const opaque = reporter.captureCrash(error, {
      source: 'window',
      errorContext: { opaque: true, errorPresent: false },
    });
    expect(opaque).not.toBe(resource);

    await Promise.all([resource.submit(), opaque.submit()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed incident retryable with the original event id and reports no upload errors recursively', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const incident = reporter.captureCrash(new Error('page failed'), {
      source: 'bootstrap',
    });
    await incident.submit();
    expect(incident.getSnapshot().status).toBe('failed');
    const id = JSON.parse(fetchMock.mock.calls[0][1].body).eventId;
    await incident.submit();
    expect(incident.getSnapshot()).toEqual({ status: 'sent', reportId: id });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).eventId).toBe(id);
  });

  it('does not claim success without a matching server receipt', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'wrong-id' }),
    });
    const incident = reporter.captureCrash('failed', { source: 'route' });
    await incident.submit();
    expect(incident.getSnapshot().status).toBe('failed');
  });

  it('caps an error storm even when errors share a timestamp, with manual reporting still available', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const entries = Array.from({ length: 10 }, (_, index) =>
      reporter.captureCrash(`error ${index}`, { source: 'window' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(entries[9].getSnapshot().status).toBe('limited');
    await entries[9].submit();
    expect(entries[9].getSnapshot().status).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('reports with inaccessible browser storage and bounds multi-byte stacks for keepalive', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const error = new Error('中文错误');
    error.stack = '错'.repeat(16000);
    const incident = reporter.captureCrash(error, {
      source: 'react',
      componentStack: '错'.repeat(16000),
    });
    await incident.submit();
    expect(incident.getSnapshot().status).toBe('sent');
    expect(
      new TextEncoder().encode(fetchMock.mock.calls[0][1].body).byteLength,
    ).toBeLessThanOrEqual(60000);
  });

  it('bounds multi-byte payloads by UTF-8 bytes when TextEncoder is unavailable', async () => {
    const NativeTextEncoder = globalThis.TextEncoder;
    if (!NativeTextEncoder)
      throw new Error('TextEncoder unavailable in test runtime');
    vi.stubGlobal('TextEncoder', undefined);

    const error = new Error('中文错误');
    error.stack = '错'.repeat(16000);
    const incident = reporter.captureCrash(error, {
      source: 'react',
      componentStack: '错'.repeat(16000),
    });
    await incident.submit();

    expect(incident.getSnapshot().status).toBe('sent');
    expect(
      new NativeTextEncoder().encode(fetchMock.mock.calls[0][1].body)
        .byteLength,
    ).toBeLessThanOrEqual(60000);
  });

  it('aborts a stalled upload so the manual retry cannot stay disabled forever', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const incident = reporter.captureCrash('timeout', { source: 'window' });
    const pending = incident.submit();
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(incident.getSnapshot().status).toBe('failed');
  });

  it('retries recurring errors after the reporting window and preserves object rejection stacks', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const error = {
      name: 'TimeoutError',
      message: 'service failed',
      stack: 'at service.ts:1:2',
    };
    const first = reporter.captureCrash(error, {
      source: 'unhandledrejection',
    });
    await first.submit();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stack).toBe(error.stack);
    vi.spyOn(Date, 'now').mockReturnValue(62000);
    const next = reporter.captureCrash(error, { source: 'unhandledrejection' });
    await next.submit();
    expect(next).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('makes upload setup failures retryable without rejecting the reporting promise', async () => {
    vi.stubGlobal('AbortController', undefined);
    const incident = reporter.captureCrash('setup failed', {
      source: 'bootstrap',
    });
    await expect(incident.submit()).resolves.toBeUndefined();
    expect(incident.getSnapshot().status).toBe('failed');
  });

  it('redacts secret-bearing route parameters and named credentials', async () => {
    window.history.replaceState({}, '', '/replay/shared/private-grant');
    const incident = reporter.captureCrash(
      'api_key=secret cookie=session refresh_token=private',
      { source: 'route' },
    );
    await incident.submit();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.url).toBe('http://localhost:3000/replay/shared/[redacted]');
    expect(payload.message).toBe(
      'api_key=[redacted] cookie=[redacted] refresh_token=[redacted]',
    );
  });

  it('captures opaque window errors without manufacturing a stack', async () => {
    reporter.installCrashReporting();
    const event = new ErrorEvent('error', {
      message: 'Script error.',
      filename: 'http://localhost:3000/assets/chunk.js?token=private',
      lineno: 17,
      colno: 9,
    });
    window.dispatchEvent(event);
    await Promise.resolve();

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.stack).toBeUndefined();
    expect(payload.errorContext).toMatchObject({
      opaque: true,
      errorPresent: false,
      filename: 'http://localhost:3000/assets/chunk.js',
      line: 17,
      column: 9,
    });
    expect(fetchMock.mock.calls[0][1].body).not.toContain('private');
  });

  it('includes available environment facts and the current game UUID', async () => {
    const savedNavigator = new Map<string, PropertyDescriptor | undefined>();
    const savedWindow = new Map<string, PropertyDescriptor | undefined>();
    const setProperty = (
      target: object,
      key: string,
      value: unknown,
      saved: Map<string, PropertyDescriptor | undefined>,
    ) => {
      saved.set(key, Object.getOwnPropertyDescriptor(target, key));
      Object.defineProperty(target, key, {
        configurable: true,
        value,
      });
    };
    const restore = (
      target: object,
      saved: Map<string, PropertyDescriptor | undefined>,
    ) => {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete (target as Record<string, unknown>)[key];
      }
    };

    try {
      setProperty(navigator, 'languages', ['en-US', 'zh-CN'], savedNavigator);
      setProperty(navigator, 'platform', 'TestOS', savedNavigator);
      setProperty(navigator, 'vendor', 'TestVendor', savedNavigator);
      setProperty(navigator, 'onLine', false, savedNavigator);
      setProperty(navigator, 'hardwareConcurrency', 8, savedNavigator);
      setProperty(navigator, 'deviceMemory', 4, savedNavigator);
      setProperty(navigator, 'maxTouchPoints', 2, savedNavigator);
      setProperty(navigator, 'cookieEnabled', true, savedNavigator);
      setProperty(navigator, 'standalone', true, savedNavigator);
      setProperty(
        navigator,
        'serviceWorker',
        { controller: {} },
        savedNavigator,
      );
      setProperty(
        navigator,
        'connection',
        { effectiveType: '4g', downlink: 12, rtt: 30, saveData: false },
        savedNavigator,
      );
      setProperty(window, 'innerWidth', 1280, savedWindow);
      setProperty(window, 'innerHeight', 720, savedWindow);
      setProperty(window, 'devicePixelRatio', 2, savedWindow);
      setProperty(window.screen, 'width', 2560, savedWindow);
      setProperty(window.screen, 'height', 1440, savedWindow);
      setProperty(window.screen, 'colorDepth', 24, savedWindow);
      window.history.replaceState(
        {},
        '',
        '/game/123e4567-e89b-12d3-a456-426614174000/end?secret=private',
      );

      const incident = reporter.captureCrash(new Error('resource failed'), {
        source: 'resource',
      });
      await incident.submit();
      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.gameId).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(payload.environment).toMatchObject({
        languages: ['en-US', 'zh-CN'],
        platform: 'TestOS',
        vendor: 'TestVendor',
        online: false,
        viewport: { width: 1280, height: 720 },
        screen: { width: 2560, height: 1440, colorDepth: 24 },
        devicePixelRatio: 2,
        hardwareConcurrency: 8,
        deviceMemory: 4,
        maxTouchPoints: 2,
        cookieEnabled: true,
        standalone: true,
        serviceWorker: 'controlled',
        connection: {
          effectiveType: '4g',
          downlink: 12,
          rtt: 30,
          saveData: false,
        },
      });
    } finally {
      restore(navigator, savedNavigator);
      restore(window, savedWindow);
      window.history.replaceState({}, '', '/auth');
    }
  });

  it('snapshots the token at capture and keeps it out of the payload', async () => {
    let token = 'token-a';
    reporter.setCrashContextProvider(() => token);
    let resolveFetch: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const eventId = JSON.parse(String(init.body)).eventId;
      return new Promise<Response>((resolve) => {
        resolveFetch = () =>
          resolve({
            ok: true,
            json: async () => ({ id: eventId, reportId: 'group-1' }),
          } as Response);
      });
    });

    const incident = reporter.captureCrash(new Error('auth transition'), {
      source: 'window',
    });
    token = 'token-b';
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-a' });
    expect(init.body).not.toContain('token-a');
    expect(init.body).not.toContain('token-b');
    resolveFetch?.(undefined as never);
    await incident.submit();
    expect(incident.getSnapshot()).toEqual({
      status: 'sent',
      reportId: 'group-1',
    });
  });

  it('preserves the stale chunk recovery marker and accepts the canonical group receipt', async () => {
    sessionStorage.setItem('seti:stale-chunk-reload-at', '4242');
    const incident = reporter.captureCrash(
      'Failed to fetch dynamically imported module: /assets/GameEndPage-abc.js?token=private',
      { source: 'resource' },
    );
    await incident.submit();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.errorContext).toMatchObject({
      resourceUrl: 'http://localhost:3000/assets/GameEndPage-abc.js',
      previousRecoveryAt: '1970-01-01T00:00:04.242Z',
    });
    expect(incident.getSnapshot().reportId).toBe(payload.eventId);
    expect(fetchMock.mock.calls[0][1].body).not.toContain('private');
  });

  it('sanitizes credentials, query strings and bearer values', () => {
    expect(
      reporter.sanitizeCrashText(
        'https://user:pass@site.test/auth?code=x#private Bearer secret.jwt token=secret',
        500,
      ),
    ).toBe('https://site.test/auth Bearer [redacted] token=[redacted]');
  });

  it('redacts quoted JSON credential keys and values', () => {
    expect(
      reporter.sanitizeCrashText(
        '{"accessToken":"access-secret","refresh_token":"refresh-secret","password": "password secret"}',
        500,
      ),
    ).toBe(
      '{"accessToken":"[redacted]","refresh_token":"[redacted]","password": "[redacted]"}',
    );
  });
});
