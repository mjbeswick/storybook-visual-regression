#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, rmSync } from 'fs';
import type { VisualRegressionConfig } from '../types/index.js';
import { createDefaultConfig } from '../config/defaultConfig.js';
import { StorybookConfigDetector } from '../core/StorybookConfigDetector.js';
import execa from 'execa';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const program = new Command();

async function createConfigFromOptions(
  options: any,
  cwd: string,
): Promise<VisualRegressionConfig> {
  const defaultConfig = createDefaultConfig();
  const detector = new StorybookConfigDetector(cwd);

  // Detect Storybook configuration from the project
  const detectedConfig = await detector.detectAndMergeConfig(defaultConfig);

  // Construct proper URL with port
  const port = parseInt(options.port) || detectedConfig.storybookPort;
  const baseUrl = options.url || 'http://localhost';
  const storybookUrl = baseUrl.includes(`:${port}`) ? baseUrl : `${baseUrl}:${port}`;

  return {
    ...detectedConfig,
    storybookUrl,
    storybookPort: port,
    storybookCommand: options.command || detectedConfig.storybookCommand,
    workers: parseInt(options.workers) || detectedConfig.workers,
    retries: parseInt(options.retries) || detectedConfig.retries,
    timeout: detectedConfig.timeout,
    serverTimeout: parseInt(options.webserverTimeout ?? '') || detectedConfig.serverTimeout,
    headless: detectedConfig.headless,
    timezone: options.timezone || detectedConfig.timezone,
    locale: options.locale || detectedConfig.locale,
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

async function runWithPlaywrightReporter(options: any): Promise<void> {
  // Get the main project directory where the CLI is installed
  const originalCwd = process.cwd();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const projectRoot = join(__dirname, '..', '..');

  const config = await createConfigFromOptions(options, originalCwd);
  const storybookCommand = config.storybookCommand || 'npm run storybook';
  const storybookLaunchCommand = `${storybookCommand} -- --ci --port ${config.storybookPort}`;

  // Set environment variables for Playwright
  process.env.PLAYWRIGHT_RETRIES = config.retries.toString();
  process.env.PLAYWRIGHT_WORKERS = config.workers.toString();
  process.env.PLAYWRIGHT_MAX_FAILURES = (options.maxFailures || 1).toString();
  process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS = options.updateSnapshots ? 'true' : 'false';
  process.env.STORYBOOK_URL = config.storybookUrl;
  process.env.PLAYWRIGHT_HEADLESS = config.headless ? 'true' : 'false';
  process.env.PLAYWRIGHT_TIMEZONE = config.timezone;
  process.env.PLAYWRIGHT_LOCALE = config.locale;
  process.env.STORYBOOK_COMMAND = storybookLaunchCommand;
  process.env.STORYBOOK_CWD = originalCwd; // Use original working directory for Storybook
  process.env.STORYBOOK_TIMEOUT = config.serverTimeout.toString();
  process.env.ORIGINAL_CWD = originalCwd;

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

  console.log('');
  console.log(chalk.bold('▶️  Launching Playwright Test'));
  console.log(
    `${chalk.dim('  •')} Storybook command: ${chalk.cyan(storybookLaunchCommand)} (${chalk.dim(
      storybookCommand,
    )})`,
  );
  console.log(`${chalk.dim('  •')} Working directory: ${chalk.cyan(originalCwd)}`);
  console.log(`${chalk.dim('  •')} Waiting for Storybook output...`);

  try {
    const playwrightArgs = ['playwright', 'test'];

    // Use our config file instead of the project's config
    // Get the path to our config file relative to this CLI file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const projectRoot = join(__dirname, '..', '..');
    const configPath = join(projectRoot, 'svr.config.ts');
    playwrightArgs.push('--config', configPath);

    const child = execa('npx', playwrightArgs, {
      cwd: projectRoot, // Run from the main project directory where CLI is installed
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
      // Force Playwright to use absolute paths and not create its own config
      env: {
        ...process.env,
        // Prevent Playwright from creating its own config in the wrong location
        PLAYWRIGHT_CONFIG_FILE: configPath,
        // Force Playwright to use the correct working directory
        PLAYWRIGHT_TEST_DIR: join(projectRoot, 'src', 'tests'),
        PLAYWRIGHT_RETRIES: config.retries.toString(),
        PLAYWRIGHT_WORKERS: config.workers.toString(),
        PLAYWRIGHT_MAX_FAILURES: (options.maxFailures || 1).toString(),
        PLAYWRIGHT_UPDATE_SNAPSHOTS: options.updateSnapshots ? 'true' : 'false',
        STORYBOOK_URL: config.storybookUrl,
        PLAYWRIGHT_HEADLESS: config.headless ? 'true' : 'false',
        PLAYWRIGHT_TIMEZONE: config.timezone,
        PLAYWRIGHT_LOCALE: config.locale,
        PLAYWRIGHT_OUTPUT_DIR: join(originalCwd, options.output || 'visual-regression'),
        STORYBOOK_COMMAND: storybookLaunchCommand,
        STORYBOOK_CWD: originalCwd,
        STORYBOOK_TIMEOUT: config.serverTimeout.toString(),
        ORIGINAL_CWD: originalCwd,
      },
    });

    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    await child;

    console.log(chalk.green('✅ Visual regression tests completed successfully'));

    if (options.updateSnapshots) {
      const resultsDir = join(originalCwd, options.output || 'visual-regression', 'results');
      if (existsSync(resultsDir)) {
        try {
          rmSync(resultsDir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn(
            chalk.yellow(
              `⚠️  Unable to clean Playwright results directory at ${resultsDir}: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
            ),
          );
        }
      }
    }
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
  .option('-w, --workers <number>', 'Number of parallel workers', '12')
  .option('-c, --command <command>', 'Command to start Storybook server', 'npm run storybook')
  .option('--webserver-timeout <ms>', 'Playwright webServer startup timeout in milliseconds', '120000')
  .option('--retries <number>', 'Number of retries on failure', '2')
  .option('--max-failures <number>', 'Stop after N failures (<=0 disables)', '1')
  .option('--timezone <timezone>', 'Browser timezone', 'Europe/London')
  .option('--locale <locale>', 'Browser locale', 'en-GB')
  .option('--debug', 'Enable debug logging')
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
  .option('-w, --workers <number>', 'Number of parallel workers', '12')
  .option('-c, --command <command>', 'Command to start Storybook server', 'npm run storybook')
  .option('--webserver-timeout <ms>', 'Playwright webServer startup timeout in milliseconds', '120000')
  .option('--retries <number>', 'Number of retries on failure', '2')
  .option('--max-failures <number>', 'Stop after N failures (<=0 disables)', '1')
  .option('--timezone <timezone>', 'Browser timezone', 'Europe/London')
  .option('--locale <locale>', 'Browser locale', 'en-GB')
  .option('--debug', 'Enable debug logging')
  .action(async (options) => {
    options.updateSnapshots = true;
    await runTests(options);
  });

program.parse();
