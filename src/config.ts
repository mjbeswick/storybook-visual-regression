import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { VisualRegressionConfig } from './types/index.js';
import { createDefaultConfig } from './config/defaultConfig.js';
import { tryLoadRuntimeOptions } from './runtime/runtime-options.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function ensureDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw new Error(
      `Unable to create directory at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function createPlaywrightConfig(
  userConfig: VisualRegressionConfig,
  updateMode: boolean = false,
) {
  ensureDirectory(userConfig.snapshotPath);
  ensureDirectory(userConfig.resultsPath);

  const storybookIndexUrl = `${userConfig.storybookUrl.replace(/\/$/, '')}/index.json`;
  // Ensure the Storybook webServer runs in the caller's project directory, not this tool's repo
  // This is sourced from runtime options written by the CLI before invoking Playwright
  const runtimeOptions = tryLoadRuntimeOptions();
  const webServerCwd = runtimeOptions?.originalCwd ?? process.cwd();

  // Wrap command in shell to ensure proper npm/pnpm/yarn resolution with version managers
  const wrappedCommand = userConfig.storybookCommand
    ? `${process.env.SHELL || '/bin/sh'} -c "${userConfig.storybookCommand.replace(/"/g, '\\"')}"`
    : undefined;

  // Get test timeout from runtime options if available, otherwise use a sensible default
  const testTimeout = runtimeOptions?.testTimeout ?? 60000; // Default to 60s

  return defineConfig({
    testDir: join(__dirname, 'tests'),
    outputDir: userConfig.resultsPath,
    fullyParallel: true,
    retries: userConfig.retries,
    workers: userConfig.workers,
    maxFailures: userConfig.maxFailures,
    reporter: 'list',
    updateSnapshots: updateMode ? 'all' : 'none',
    timeout: testTimeout, // Set per-test timeout to prevent "Test timeout exceeded" errors
    globalSetup: join(__dirname, 'tests', 'global-setup.js'),
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
    snapshotPathTemplate: join(userConfig.snapshotPath, '{arg}{ext}'),
    expect: {
      toHaveScreenshot: {
        threshold: userConfig.threshold,
        animations: userConfig.disableAnimations ? 'disabled' : 'allow',
      },
    },
    webServer: wrappedCommand
      ? {
          command: wrappedCommand,
          url: storybookIndexUrl,
          reuseExistingServer: true,
          timeout: userConfig.serverTimeout,
          cwd: webServerCwd,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            NODE_ENV: 'development',
            NODE_NO_WARNINGS: '1',
          },
          ignoreHTTPSErrors: true,
        }
      : undefined,
  });
}

function resolveConfigFromRuntime(): { config: VisualRegressionConfig; updateMode: boolean } {
  const runtimeOptions = tryLoadRuntimeOptions();
  if (runtimeOptions) {
    return {
      config: runtimeOptions.visualRegression,
      updateMode: runtimeOptions.updateSnapshots,
    };
  }

  return {
    config: createDefaultConfig(),
    updateMode: false,
  };
}

const { config, updateMode } = resolveConfigFromRuntime();

export default createPlaywrightConfig(config, updateMode);
