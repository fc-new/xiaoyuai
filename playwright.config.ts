import { defineConfig } from '@playwright/test';
import { scryptSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const salt = 'e2e-fixture';
const webPort = Number(process.env.E2E_WEB_PORT || 15173);
const apiPort = Number(process.env.E2E_API_PORT || 13001);
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: 45000,
  reporter: 'list', use: { baseURL: `http://localhost:${webPort}`, trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
  webServer: { command: 'npm run dev', url: `http://localhost:${webPort}`, reuseExistingServer: false, timeout: 30000,
    env: { VOUCHER_SECRET: 'a1'.repeat(32), PAYMENT_MODE: 'demo', WEB_PORT: String(webPort), PORT: String(apiPort), APP_ORIGIN: `http://localhost:${webPort}`, DATABASE_PATH: join(mkdtempSync(join(tmpdir(), 'xiaoyuai-e2e-')), 'test.sqlite'),
      ADMIN_PASSWORD_HASH: `${salt}:${scryptSync('e2e-password', salt, 64).toString('hex')}`,
      DATABASE_URL: '', REQUIRE_DATABASE_URL: '', ADMIN_PASSWORD: '', RENDER: 'false', TRUST_PROXY_HOPS: '0' } },
});
