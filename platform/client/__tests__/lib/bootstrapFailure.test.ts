import { cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { showBootstrapFailure } from '@/lib/bootstrapFailure';
import { forceReloadLatestVersion } from '@/lib/forceReloadLatestVersion';

vi.mock('@/lib/forceReloadLatestVersion', () => ({
  forceReloadLatestVersion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/crashReporter', () => ({
  captureCrash: vi.fn(() => ({
    getSnapshot: () => ({ status: 'failed' }),
    subscribe: () => vi.fn(),
    submit: vi.fn().mockResolvedValue(undefined),
  })),
}));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});
it('shows recovery and a manual report button without React, router or i18n providers', () => {
  document.body.innerHTML = '<div id="root"></div>';
  const error = new Error('Module failed <script>alert(1)</script>');
  showBootstrapFailure(error);
  showBootstrapFailure(error);
  expect(document.querySelectorAll('#bootstrap-failure')).toHaveLength(1);
  expect(document.getElementById('root')?.hidden).toBe(true);
  expect(document.getElementById('bootstrap-failure')?.textContent).toContain(
    'Could not send the report',
  );
  expect(document.querySelector('pre')?.textContent).toContain(error.message);
  expect(document.querySelector('script')).toBeNull();
  expect(
    [...document.querySelectorAll('button')].map(
      (button) => button.textContent,
    ),
  ).toContain('Report error');
});

it('refreshes the app shell once while recovery is pending', async () => {
  let finishReload!: () => void;
  vi.mocked(forceReloadLatestVersion).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishReload = resolve;
      }),
  );
  showBootstrapFailure(
    new Error('Failed to fetch dynamically imported module'),
  );
  const reload = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Refresh page',
  ) as HTMLButtonElement;

  reload.click();
  reload.click();

  expect(forceReloadLatestVersion).toHaveBeenCalledOnce();
  expect(reload.disabled).toBe(true);
  finishReload();
  await vi.waitFor(() => expect(reload.disabled).toBe(false));
});
