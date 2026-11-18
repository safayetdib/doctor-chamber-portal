import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const mongoUri = process.env.SMOKE_MONGODB_URI;
if (!mongoUri) throw new Error('Set SMOKE_MONGODB_URI to the local test replica set before running the smoke suite.');
const database = process.env.SMOKE_MONGODB_DB ?? `practice_smoke_${randomBytes(6).toString('hex')}`;
if (!/^practice_smoke_[a-z0-9_]+$/.test(database)) throw new Error('SMOKE_MONGODB_DB must be a fresh practice_smoke_* database.');

const frontend = 'http://127.0.0.1:3000';
const backend = 'http://127.0.0.1:4000';
const channel = process.env.SMOKE_BROWSER_CHANNEL || undefined;

// Playwright workers load the config again. Inherit the same synthetic credential.
process.env.SMOKE_ADMIN_PASSWORD ??= randomBytes(24).toString('hex');

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel } }
  ],
  use: { baseURL: frontend, actionTimeout: 12_000 },
  webServer: [
    {
      command: 'pnpm --filter @practice/backend smoke:prepare && pnpm --filter @practice/backend start',
      url: backend + '/api/v1/health/ready',
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '4000', PUBLIC_APP_ORIGIN: frontend,
        MONGODB_URI: mongoUri, MONGODB_MIGRATION_URI: mongoUri, MONGODB_DB: database,
        SUPERUSER_LOGIN_ID: 'smoke-admin', SUPERUSER_NAME: 'Synthetic Administrator',
        SUPERUSER_PASSWORD: process.env.SMOKE_ADMIN_PASSWORD
      }
    },
    {
      command: 'pnpm --filter @practice/frontend start --port 3000',
      url: frontend,
      reuseExistingServer: false,
      env: { NODE_ENV: 'production', API_INTERNAL_ORIGIN: backend }
    }
  ]
});
