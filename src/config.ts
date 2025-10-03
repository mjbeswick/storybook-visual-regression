import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  testDir: join(__dirname, 'tests'),
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR
    ? `${process.env.PLAYWRIGHT_OUTPUT_DIR}/results`
    : 'visual-regression/results',
  fullyParallel: true,
  retries: parseInt(process.env.PLAYWRIGHT_RETRIES || '0'),
  workers: parseInt(process.env.PLAYWRIGHT_WORKERS || '12'),
  maxFailures: parseInt(process.env.PLAYWRIGHT_MAX_FAILURES || '1'),
  reporter: process.env.PLAYWRIGHT_REPORTER || 'list',
  updateSnapshots: process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS === 'true' ? 'all' : 'none',
  use: {
    baseURL: process.env.STORYBOOK_URL || 'http://localhost:9009',
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    timezoneId: process.env.PLAYWRIGHT_TIMEZONE || 'Europe/London',
    locale: process.env.PLAYWRIGHT_LOCALE || 'en-GB',
    screenshot: 'only-on-failure',
  },
  snapshotPathTemplate: process.env.PLAYWRIGHT_OUTPUT_DIR
    ? `${process.env.PLAYWRIGHT_OUTPUT_DIR}/snapshots/{arg}{ext}`
    : 'visual-regression/snapshots/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      threshold: 0.2,
      animations: 'disabled',
    },
  },
  webServer: {
    command: process.env.STORYBOOK_COMMAND || 'npm run storybook',
    url: `${(process.env.STORYBOOK_URL || 'http://localhost:9009').replace(/\/$/, '')}/index.json`,
    reuseExistingServer: true,
    timeout: parseInt(process.env.STORYBOOK_TIMEOUT || '120000'),
    cwd: process.env.STORYBOOK_CWD,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NODE_NO_WARNINGS: '1',
    },
    ignoreHTTPSErrors: true,
  },
});
