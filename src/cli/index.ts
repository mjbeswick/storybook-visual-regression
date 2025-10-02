#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { VisualRegressionConfig } from '../types/index.js';
import { createDefaultConfig } from '../config/defaultConfig.js';
import execa from 'execa';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const program = new Command();

function createConfigFromOptions(options: any): VisualRegressionConfig {
  const defaultConfig = createDefaultConfig();

  // Construct proper URL with port
  const port = parseInt(options.port) || defaultConfig.storybookPort;
  const baseUrl = options.url || 'http://localhost';
  const storybookUrl = baseUrl.includes(`:${port}`) ? baseUrl : `${baseUrl}:${port}`;

  return {
    ...defaultConfig,
    storybookUrl,
    storybookPort: port,
    storybookCommand: options.command || defaultConfig.storybookCommand,
    workers: parseInt(options.workers) || defaultConfig.workers,
    retries: parseInt(options.retries) || defaultConfig.retries,
    timeout: parseInt(options.timeout) || defaultConfig.timeout,
    serverTimeout: parseInt(options.serverTimeout) || defaultConfig.serverTimeout,
    headless: options.headless !== 'false',
    timezone: options.timezone || defaultConfig.timezone,
    locale: options.locale || defaultConfig.locale,
  };
}

// Helper function to wait for Storybook server to be ready
async function waitForStorybookServer(url: string, timeout: number): Promise<void> {
  const startTime = Date.now();
  const maxWaitTime = timeout;

  console.log(`Waiting for Storybook server to be ready at ${url}...`);

  // Give Storybook some time to start up before we start polling
  console.log('Giving Storybook 5 seconds to start up...');
  await new Promise((resolve) => setTimeout(resolve, 5000));

  let attempt = 1;
  while (Date.now() - startTime < maxWaitTime) {
    try {
      console.log(`Checking if Storybook is ready (attempt ${attempt})...`);

      // Try the main page first (faster to respond)
      const mainResponse = await fetch(url, {
        signal: AbortSignal.timeout(3000),
      });

      if (mainResponse.ok) {
        console.log('Storybook main page is accessible, checking index.json...');

        // Now try the index.json endpoint
        const indexResponse = await fetch(`${url}/index.json`, {
          signal: AbortSignal.timeout(5000),
        });

        if (indexResponse.ok) {
          console.log(`✅ Storybook server is ready at ${url}`);
          return;
        } else {
          console.log(`Index.json not ready yet (${indexResponse.status})`);
        }
      } else {
        console.log(`Main page not ready yet (${mainResponse.status})`);
      }
    } catch (error) {
      console.log(
        `Connection attempt ${attempt} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }

    attempt++;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    `Storybook server did not start within ${timeout}ms. Please check if Storybook is running manually at ${url}`,
  );
}

program
  .name('storybook-visual-regression')
  .description('Visual regression testing tool for Storybook')
  .version('1.0.0');

// Shared runner used by multiple commands
async function runTests(options: any) {
  const startedAt = Date.now();

  try {
    // Always use Playwright reporter path for proper webServer handling
    await runWithPlaywrightReporter(options);
  } catch (error) {
    console.log(chalk.red('Test execution failed'));
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    process.exit(1);
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function parseCommand(command: string): { command: string; args: string[] } {
  // Always use shell execution for better compatibility
  return { command: 'sh', args: ['-c', command] };
}

async function runWithPlaywrightReporter(options: any): Promise<void> {
  const config = createConfigFromOptions(options);
  const parsedCommand = parseCommand(config.storybookCommand ?? 'npm run dev:ui');

  // Set environment variables for Playwright
  process.env.PLAYWRIGHT_RETRIES = config.retries.toString();
  process.env.PLAYWRIGHT_WORKERS = config.workers.toString();
  process.env.PLAYWRIGHT_MAX_FAILURES = (options.maxFailures || 1).toString();
  process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS = options.updateSnapshots ? 'true' : 'false';
  process.env.STORYBOOK_URL = config.storybookUrl;
  process.env.PLAYWRIGHT_HEADLESS = config.headless ? 'true' : 'false';
  process.env.PLAYWRIGHT_TIMEZONE = config.timezone;
  process.env.PLAYWRIGHT_LOCALE = config.locale;
  process.env.STORYBOOK_COMMAND = `sh -c "${config.storybookCommand} --ci --port ${config.storybookPort}"`;
  process.env.STORYBOOK_CWD = process.cwd();
  process.env.STORYBOOK_TIMEOUT = config.serverTimeout.toString();
  process.env.ORIGINAL_CWD = process.cwd();

  // Debug logging
  if (options.debug) {
    console.log(chalk.blue('🔍 Debug: Environment variables set:'));
    console.table({
      PLAYWRIGHT_RETRIES: process.env.PLAYWRIGHT_RETRIES,
      PLAYWRIGHT_WORKERS: process.env.PLAYWRIGHT_WORKERS,
      PLAYWRIGHT_MAX_FAILURES: process.env.PLAYWRIGHT_MAX_FAILURES,
      PLAYWRIGHT_UPDATE_SNAPSHOTS: process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS,
      STORYBOOK_URL: process.env.STORYBOOK_URL,
      PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS,
      PLAYWRIGHT_TIMEZONE: process.env.PLAYWRIGHT_TIMEZONE,
      PLAYWRIGHT_LOCALE: process.env.PLAYWRIGHT_LOCALE,
      STORYBOOK_COMMAND: process.env.STORYBOOK_COMMAND,
      STORYBOOK_CWD: process.env.STORYBOOK_CWD,
      STORYBOOK_TIMEOUT: process.env.STORYBOOK_TIMEOUT,
    });
  }

  console.log(chalk.gray('Running Playwright Test with static configuration...'));

  try {
    const playwrightArgs = ['playwright', 'test'];

    // Use our config file instead of the project's config
    // Get the path to our config file relative to this CLI file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const configPath = join(__dirname, '..', '..', 'storybook-visual-regression.config.ts');
    playwrightArgs.push('--config', configPath);

    const result = await execa('npx', playwrightArgs, {
      cwd: process.cwd(), // Run from the current working directory where CLI is executed
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_RETRIES: config.retries.toString(),
        PLAYWRIGHT_WORKERS: config.workers.toString(),
        PLAYWRIGHT_MAX_FAILURES: (options.maxFailures || 1).toString(),
        PLAYWRIGHT_UPDATE_SNAPSHOTS: options.updateSnapshots ? 'true' : 'false',
        STORYBOOK_URL: config.storybookUrl,
        PLAYWRIGHT_HEADLESS: config.headless ? 'true' : 'false',
        PLAYWRIGHT_TIMEZONE: config.timezone,
        PLAYWRIGHT_LOCALE: config.locale,
        PLAYWRIGHT_OUTPUT_DIR: options.output || 'visual-regression',
        STORYBOOK_COMMAND: `sh -c "${config.storybookCommand} --ci --port ${config.storybookPort}"`,
        STORYBOOK_CWD: process.cwd(),
        STORYBOOK_TIMEOUT: config.serverTimeout.toString(),
        ORIGINAL_CWD: process.cwd(),
      },
    });

    console.log(chalk.green('✅ Visual regression tests completed successfully'));
  } catch (error) {
    console.error(chalk.red('❌ Test execution failed'));
    if (error instanceof Error) {
      console.error(chalk.red(error.message));
    }
    throw error;
  }
}

program
  .command('test')
  .description('Run visual regression tests')
  .option('-p, --port <port>', 'Storybook server port', '9009')
  .option('-u, --url <url>', 'Storybook server URL', 'http://localhost')
  .option('-o, --output <dir>', 'Output directory for results', 'visual-regression')
  .option('-b, --browser <browser>', 'Browser to use (chromium|firefox|webkit)', 'chromium')
  .option('-t, --threshold <number>', 'Visual difference threshold (0-1)', '0.2')
  .option('-w, --workers <number>', 'Number of parallel workers', '12')
  .option('--timeout <ms>', 'Test timeout in milliseconds', '30000')
  .option('--action-timeout <ms>', 'Action timeout in milliseconds', '5000')
  .option('--navigation-timeout <ms>', 'Navigation timeout in milliseconds', '10000')
  .option('-c, --command <command>', 'Command to start Storybook server', 'npm run dev:ui')
  .option('--server-timeout <ms>', 'Server startup timeout in milliseconds', '120000')
  .option('--headless', 'Run in headless mode', true)
  .option('--headed', 'Run in headed mode (overrides headless)')
  .option('--disable-animations', 'Disable animations in screenshots', true)
  .option('--enable-animations', 'Enable animations in screenshots (overrides disable-animations)')
  .option('--wait-network-idle', 'Wait for network idle before capturing', true)
  .option('--no-wait-network-idle', "Don't wait for network idle")
  .option('--content-stabilization', 'Wait for content to stabilize', true)
  .option('--no-content-stabilization', "Don't wait for content stabilization")
  .option(
    '--frozen-time <time>',
    'Frozen time for deterministic results',
    '2024-01-15T10:30:00.000Z',
  )
  .option('--timezone <timezone>', 'Browser timezone', 'Europe/London')
  .option('--locale <locale>', 'Browser locale', 'en-GB')
  .option('--include <patterns>', 'Include stories matching patterns (comma-separated)')
  .option('--exclude <patterns>', 'Exclude stories matching patterns (comma-separated)')
  .option('--viewport <size>', 'Default viewport size (widthxheight)', '1024x768')
  .option('--retries <number>', 'Number of retries on failure', '2')
  .option('--update-snapshots', 'Update snapshot files instead of comparing')
  .option('--grep <pattern>', 'Run tests matching pattern')
  .option('--reporter <reporter>', 'Test reporter (line|dot|json|html)', 'line')
  .option('--use-playwright-reporter', 'Run via Playwright Test and pipe its output')
  .option('--debug', 'Enable debug logging')
  .option('--discover-viewports', 'Discover viewport configurations from Storybook', true)
  .option('--no-discover-viewports', 'Use hardcoded viewport configurations')
  .option('--max-failures <number>', 'Stop after N failures (<=0 disables)', '1')
  .action(async (options) => runTests(options));

program
  .command('install-browsers')
  .description('Install Playwright browsers')
  .option('-b, --browser <browser>', 'Browser to install (chromium|firefox|webkit|all)', 'chromium')
  .action(async (options) => {
    const spinner = ora(`Installing ${options.browser} browser...`).start();

    try {
      const { execSync } = await import('child_process');
      const browser = options.browser === 'all' ? '' : options.browser;
      execSync(`playwright install ${browser}`, { stdio: 'inherit' });

      spinner.succeed(`Successfully installed ${options.browser} browser`);
    } catch (error) {
      spinner.fail('Browser installation failed');
      console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
      process.exit(1);
    }
  });

// Update command - mirrors test but forces snapshot update and exposes key options
program
  .command('update')
  .description('Update visual regression snapshots')
  .option('-p, --port <port>', 'Storybook server port', '9009')
  .option('-u, --url <url>', 'Storybook server URL', 'http://localhost')
  .option('-o, --output <dir>', 'Output directory for results', 'visual-regression')
  .option('-b, --browser <browser>', 'Browser to use (chromium|firefox|webkit)', 'chromium')
  .option('-w, --workers <number>', 'Number of parallel workers', '12')
  .option('--locale <locale>', 'Browser locale', 'en-GB')
  .option('--timezone <timezone>', 'Browser timezone', 'Europe/London')
  .option('-c, --command <command>', 'Command to start Storybook server', 'npm run dev:ui')
  .option('--grep <pattern>', 'Update snapshots for stories matching pattern')
  .option('--debug', 'Enable debug logging')
  .option('--max-failures <number>', 'Stop after N failures (<=0 disables)', '1')
  .action(async (options) => {
    options.updateSnapshots = true;
    await runTests(options);
  });

program.parse();
