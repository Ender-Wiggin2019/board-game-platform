#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(join(tmpdir(), 'bgp-empty-platform-'));
const requireServer = createRequire(
  join(root, 'apps/platform-server/package.json'),
);
const requireTooling = createRequire(join(root, 'platform/tooling/package.json'));
const { Pool } = requireServer('pg');
const { chromium } = requireTooling('playwright');
const pgBin =
  process.env.BGP_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@17/bin';
assert(
  existsSync(join(pgBin, 'initdb')),
  'Set BGP_POSTGRES_BIN to a local PostgreSQL installation.',
);
const children = [];
let clusterStarted = false;
let pool;
let browser;
let page;
const errors = [];

async function freePort() {
  const socket = createServer();
  await new Promise((resolvePromise) =>
    socket.listen(0, '127.0.0.1', resolvePromise),
  );
  const port = socket.address().port;
  await new Promise((resolvePromise) => socket.close(resolvePromise));
  return port;
}

function start(command, args, name, env = process.env, cwd = root) {
  const stream = createWriteStream(join(output, `${name}.log`));
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  child.once('close', () => stream.end());
  children.push(child);
  return child;
}

async function run(command, args, name, env = process.env, cwd = root) {
  const child = start(command, args, name, env, cwd);
  const code = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  if (code !== 0)
    throw new Error(
      `${name} failed (${code}); inspect ${join(output, `${name}.log`)}`,
    );
}

async function waitFor(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Service exited before readiness: ${url}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* Process is still starting. */
    }
    await delay(100);
  }
  throw new Error(`Readiness timed out: ${url}`);
}

try {
  const [pgPort, apiPort, webPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  const origin = `http://127.0.0.1:${webPort}`;
  const api = `http://127.0.0.1:${apiPort}`;
  const pgData = join(output, 'pg');
  await run(
    join(pgBin, 'initdb'),
    ['-D', pgData, '-A', 'trust', '-U', 'bgp_test'],
    'initdb',
  );
  await run(
    join(pgBin, 'pg_ctl'),
    [
      '-D',
      pgData,
      '-l',
      join(output, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${pgPort} -k ${output}`,
      '-w',
      '-t',
      '15',
      'start',
    ],
    'pg-start',
  );
  clusterStarted = true;
  const admin = new Pool({
    connectionString: `postgresql://bgp_test@127.0.0.1:${pgPort}/postgres`,
  });
  await admin.query('CREATE ROLE bgp_empty_platform LOGIN');
  await admin.query(
    'CREATE DATABASE bgp_empty_platform OWNER bgp_empty_platform',
  );
  await admin.query(
    'REVOKE CONNECT ON DATABASE bgp_empty_platform FROM PUBLIC',
  );
  await admin.end();
  const databaseUrl = `postgresql://bgp_empty_platform@127.0.0.1:${pgPort}/bgp_empty_platform`;
  const image = `local/empty-platform@sha256:${'0'.repeat(64)}`;
  await writeFile(
    join(output, 'platform.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      platform: {
        id: 'empty-platform-test',
        image,
        databaseUrlEnv: 'PLATFORM_DATABASE_URL',
        brand: { name: 'Empty Platform QA' },
        features: { chat: false, rankings: false },
      },
      games: {},
    }),
  );
  await writeFile(
    join(output, 'games.lock.json'),
    JSON.stringify({
      schemaVersion: 1,
      platform: { id: 'empty-platform-test', image },
      games: {},
    }),
  );
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(apiPort),
    PLATFORM_HOST: '127.0.0.1',
    PLATFORM_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    PLATFORM_CONFIG_PATH: join(output, 'platform.config.json'),
    PLATFORM_LOCK_PATH: join(output, 'games.lock.json'),
    PLATFORM_WORKSPACE_ROOT: output,
    PLATFORM_ALLOW_INSECURE_LOCALHOST: 'true',
    PUBLIC_ORIGIN: origin,
    JWT_SECRET: randomBytes(32).toString('hex'),
    PLATFORM_DEV_BACKEND_URL: api,
  };
  delete env.CORS_ORIGIN;
  await run(
    process.execPath,
    [join(root, 'apps/platform-server/dist/migrate.js')],
    'migrate',
    env,
    output,
  );
  // A second pass proves the new baseline and runtime migrations are idempotent.
  await run(
    process.execPath,
    [join(root, 'apps/platform-server/dist/migrate.js')],
    'migrate-again',
    env,
    output,
  );
  pool = new Pool({ connectionString: databaseUrl });
  const tables = (
    await pool.query(
      "SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
    )
  ).rows.map((row) => row.name);
  assert(tables.includes('public.users'));
  assert(tables.includes('board_platform_completion.records'));
  assert(
    !tables.some(
      (name) =>
        name.startsWith('board_platform_storage.') ||
        /^public\.(?:games|game_events|game_players|replay_export_files)$/u.test(
          name,
        ),
    ),
    'Empty platform created game-owned storage',
  );
  const server = start(
    process.execPath,
    [join(root, 'apps/platform-server/dist/main.js')],
    'server',
    env,
    output,
  );
  await waitFor(`${api}/health/ready`, server);
  const publicConfigurationResponse = await fetch(
    `${api}/api/platform/config`,
    { headers: { origin } },
  );
  assert.equal(
    publicConfigurationResponse.status,
    200,
    'Public platform configuration is unavailable',
  );
  const publicConfiguration = await publicConfigurationResponse.json();
  assert.deepEqual(publicConfiguration, {
    brand: { name: 'Empty Platform QA' },
    features: { chat: false, rankings: false },
  });
  assert(
    !Object.hasOwn(publicConfiguration, 'platformId'),
    'Public configuration leaked platform identity',
  );
  assert(
    !Object.hasOwn(publicConfiguration, 'databaseUrl'),
    'Public configuration leaked database settings',
  );
  const password = `Smoke-${randomBytes(18).toString('hex')}!`;
  const email = 'empty-platform-smoke@example.invalid';
  const registered = await fetch(`${api}/api/auth/register`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      name: 'EmptyPlatformTester',
      password,
      passwordConfirm: password,
      consentVersion: 'account-registration-v1',
      language: 'en',
    }),
  });
  assert.equal(
    registered.status,
    201,
    `Fresh-platform registration failed (${registered.status})`,
  );
  await pool.query("UPDATE users SET role = 'admin' WHERE email = $1", [email]);
  const web = start(
    'corepack',
    [
      'pnpm',
      '--filter',
      '@board-platform/platform-client',
      'dev',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    'client',
    env,
  );
  await waitFor(origin, web);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/auth`, { waitUntil: 'networkidle' });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.getByTestId('auth-login-submit').click();
  await page.getByTestId('game-home').waitFor();
  await page
    .getByText(/^(No game modes are available\.|当前没有可用的游戏模式。)$/u)
    .waitFor();
  await page.getByText('Empty Platform QA', { exact: true }).first().waitFor();
  assert.equal(await page.title(), 'Empty Platform QA');
  await page.screenshot({
    path: join(output, 'empty-desktop.png'),
    fullPage: true,
  });
  await page.goto(`${origin}/platform/sessions`, { waitUntil: 'networkidle' });
  await page.getByTestId('platform-sessions-page').waitFor();
  await page.getByTestId('platform-session-directory').waitFor();
  await page.screenshot({
    path: join(output, 'empty-sessions-desktop.png'),
    fullPage: true,
  });
  await page.goto(`${origin}/account`, { waitUntil: 'networkidle' });
  await page.locator('#account-name').waitFor();
  assert.equal(
    await page.locator('#account-name').inputValue(),
    'EmptyPlatformTester',
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#account-name').waitFor();
  assert.equal(
    await page.locator('#account-name').inputValue(),
    'EmptyPlatformTester',
  );
  await page.goto(`${origin}/platform/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('cell').filter({ hasText: email }).waitFor();
  const releasesTab = page.getByRole('button', {
    name: /^(Releases|版本发布)$/u,
  });
  await releasesTab.waitFor();
  await releasesTab.click();
  await page.getByText(/^(Release registry|版本注册表)$/u).waitFor();
  await page.getByText(/^(Release reconciliation|版本一致性核对)$/u).waitFor();
  await page
    .getByLabel(
      /^(Settlement policy bundle JSON \(optional\)|结算策略包 JSON（可选）)$/u,
    )
    .waitFor();
  await page
    .getByLabel(
      /^(Approved policy versions JSON \(optional\)|已批准策略版本 JSON（可选）)$/u,
    )
    .waitFor();
  await page
    .getByText(
      /^(Configured with no desired releases|已配置，但没有期望版本)$/u,
    )
    .waitFor();
  await page.getByText(/^(No active channels\.|没有当前通道。)$/u).waitFor();
  await page.getByText(/^(No channel history\.|没有通道历史。)$/u).waitFor();
  const reconciliationDownload = page.getByRole('button', {
    name: /^(Download JSON|下载 JSON)$/u,
  });
  assert.equal(await reconciliationDownload.isEnabled(), true);
  const downloadPromise = page.waitForEvent('download');
  await reconciliationDownload.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  assert(downloadPath, 'Reconciliation JSON download did not produce a file');
  const downloadedReconciliation = JSON.parse(
    await readFile(downloadPath, 'utf8'),
  );
  assert.equal(downloadedReconciliation.schemaVersion, 1);
  assert.equal(downloadedReconciliation.desiredConfigured, true);
  assert.deepEqual(downloadedReconciliation.desired, []);
  assert.deepEqual(downloadedReconciliation.actual.channels, []);
  assert.deepEqual(downloadedReconciliation.channelHistory, []);
  await page.screenshot({
    path: join(output, 'empty-admin.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/platform/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^(Releases|版本发布)$/u }).click();
  await page.getByText(/^(Release reconciliation|版本一致性核对)$/u).waitFor();
  const adminMobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert.equal(
    adminMobileOverflow,
    false,
    'Mobile release administration overflows horizontally',
  );
  await page.screenshot({
    path: join(output, 'empty-admin-mobile.png'),
    fullPage: true,
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page
    .getByText(/^(No game modes are available\.|当前没有可用的游戏模式。)$/u)
    .waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert.equal(overflow, false, 'Mobile platform overflows horizontally');
  await page.screenshot({
    path: join(output, 'empty-mobile.png'),
    fullPage: true,
  });
  await page.goto(`${origin}/platform/sessions`, { waitUntil: 'networkidle' });
  await page.getByTestId('platform-sessions-page').waitFor();
  const sessionsMobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert.equal(sessionsMobileOverflow, false, 'Mobile sessions page overflows');
  await page.screenshot({
    path: join(output, 'empty-sessions-mobile.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, [], 'Browser runtime errors');
  const result = {
    emptyCatalog: true,
    registered: true,
    login: true,
    accountRefresh: true,
    administration: true,
    releaseAdministration: true,
    reconciliationEmptyState: true,
    reconciliationDownload: true,
    publicConfiguration,
    brandApplied: true,
    featuresDisabled: true,
    adminMobileOverflow,
    mobileOverflow: overflow,
    sessionsDirectory: true,
    sessionsMobileOverflow,
    gameOwnedTables: false,
    browserErrors: errors,
    output,
  };
  await writeFile(
    join(output, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({
      path: join(output, 'failure.png'),
      fullPage: true,
    });
    await writeFile(
      join(output, 'failure.txt'),
      JSON.stringify(
        {
          url: page.url(),
          text: await page.locator('body').innerText(),
          errors,
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await pool?.end();
  const killGroup = (child, signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  for (const child of children) killGroup(child, 'SIGTERM');
  await delay(500);
  for (const child of children) killGroup(child, 'SIGKILL');
  if (clusterStarted)
    await run(
      join(pgBin, 'pg_ctl'),
      ['-D', join(output, 'pg'), '-m', 'immediate', '-w', 'stop'],
      'pg-stop',
    );
  process.stderr.write(`Empty-platform smoke evidence: ${output}\n`);
}
