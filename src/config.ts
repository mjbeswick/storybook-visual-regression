import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { VisualRegressionConfig } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration will be passed directly from CLI
let config: VisualRegressionConfig | null = null;

export function setConfig(userConfig: VisualRegressionConfig): void {
  config = userConfig;
}

export function getConfig(): VisualRegressionConfig | null {
  return config;
}

export function createPlaywrightConfig(
  userConfig: VisualRegressionConfig,
  updateMode: boolean = false,
) {
  const storybookIndexUrl = `${userConfig.storybookUrl.replace(/\/$/, '')}/index.json`;

  return defineConfig({
    testDir: join(__dirname, 'tests'),
    outputDir: 'visual-regression/results',
    fullyParallel: true,
    retries: userConfig.retries,
    workers: userConfig.workers,
    maxFailures: userConfig.maxFailures,
    reporter: 'list',
    updateSnapshots: updateMode ? 'all' : 'none',
    projects: [
      {
        name: userConfig.browser,
        use: {
          ...(userConfig.browser === 'chromium' && { channel: 'chromium' }),
          ...(userConfig.browser === 'firefox' && { channel: 'firefox' }),
          ...(userConfig.browser === 'webkit' && { channel: 'webkit' }),
          baseURL: userConfig.storybookUrl,
          headless: userConfig.headless,
          timezoneId: userConfig.timezone,
          locale: userConfig.locale,
          screenshot: 'only-on-failure',
        },
      },
    ],
    snapshotPathTemplate: 'visual-regression/snapshots/{arg}{ext}',
    expect: {
      toHaveScreenshot: {
        threshold: userConfig.threshold,
        animations: userConfig.disableAnimations ? 'disabled' : 'allow',
      },
    },
    webServer: userConfig.storybookCommand
      ? {
          command: userConfig.storybookCommand,
          url: storybookIndexUrl,
          reuseExistingServer: true,
          timeout: userConfig.serverTimeout,
          cwd: process.cwd(),
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            NODE_ENV: 'development',
            NODE_NO_WARNINGS: '1',
          },
          ignoreHTTPSErrors: true,
        }
      : undefined,
  });
}

export default defineConfig({
  testDir: join(__dirname, 'tests'),
  outputDir: 'visual-regression/results',
  fullyParallel: true,
  retries: 0,
  workers: 16,
  maxFailures: 10,
  reporter: 'list',
  updateSnapshots: 'none',
  projects: [
    {
      name: 'chromium',
      use: {
        channel: 'chromium',
        baseURL: 'http://localhost:9009',
        headless: true,
        timezoneId: 'Europe/London',
        locale: 'en-GB',
        screenshot: 'only-on-failure',
      },
    },
  ],
  snapshotPathTemplate: 'visual-regression/snapshots/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      threshold: 0.2,
      animations: 'disabled',
    },
  },
});
