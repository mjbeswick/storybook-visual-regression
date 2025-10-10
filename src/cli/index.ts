#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, rmSync } from 'fs';
import type { VisualRegressionConfig } from '../types/index.js';
import { createDefaultConfig } from '../config/defaultConfig.js';
import { StorybookConfigDetector } from '../core/StorybookConfigDetector.js';
import { execa } from 'execa';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const program = new Command();

type CliOptions = {
  url?: string;
  port?: string;
  command?: string;
  workers?: string;
  retries?: string;
  webserverTimeout?: string;
  timezone?: string;
  locale?: string;
  maxFailures?: string;
  reporter?: string;
  quiet?: boolean;
  include?: string;
  exclude?: string;
  grep?: string;
  debug?: boolean;
  output?: string;
  updateSnapshots?: boolean;
  browser?: string;
  // Timeouts and stability tuning
  navTimeout?: string; // ms
  waitTimeout?: string; // ms
  overlayTimeout?: string; // ms
  stabilizeInterval?: string; // ms
  stabilizeAttempts?: string; // count
  // Not found check configuration
  notFoundCheck?: boolean;
  notFoundRetryDelay?: string; // ms
  // Update behavior
  missingOnly?: boolean;
  // CI convenience
  installBrowsers?: string;
  installDeps?: boolean;
};

async function createConfigFromOptions(
  options: CliOptions,
  cwd: string,
): Promise<VisualRegressionConfig> {
  const defaultConfig = createDefaultConfig();
  const detector = new StorybookConfigDetector(cwd);

  // Detect Storybook configuration from the project
  const detectedConfig = await detector.detectAndMergeConfig(defaultConfig);

  // Construct proper URL with port
  // 1) Prefer explicit --port option
  // 2) Otherwise, if --url contains an explicit port, infer it
  // 3) Fallback to detectedConfig.storybookPort
  const urlFromOptions: string | undefined = options.url;
  // Detect if user explicitly provided -p/--port on the CLI (vs. Commander default)
  const userSpecifiedPortFlag = (() => {
    const argvJoined = process.argv.slice(2).join(' ');
    return /(\s|^)(-p|--port)(\s|=)/.test(argvJoined);
  })();
  const inferredPortFromUrl = (() => {
    if (!urlFromOptions) return undefined;
    try {
      const parsed = new URL(urlFromOptions);
      return parsed.port ? parseInt(parsed.port) : undefined;
    } catch {
      // If URL() fails (e.g. missing protocol), best-effort regex to capture :<port>
      const match = String(urlFromOptions).match(/:(\d{2,5})(?:\/?|$)/);
      return match ? parseInt(match[1]) : undefined;
    }
  })();

  const port =
    userSpecifiedPortFlag && Number.isInteger(parseInt(options.port || ''))
      ? parseInt(options.port || '')
      : (inferredPortFromUrl ?? detectedConfig.storybookPort);

  const baseUrl = urlFromOptions || 'http://localhost';
  const storybookUrl = (() => {
    // If url explicitly specifies a port, keep it as-is. Else append inferred/selected port.
    if (inferredPortFromUrl) return baseUrl;
    return baseUrl.includes(`:${port}`) ? baseUrl : `${baseUrl.replace(/\/$/, '')}:${port}`;
  })();

  const parseNumberOption = (value: unknown): number | undefined => {
    const n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
    return Number.isFinite(n) && !Number.isNaN(n) ? n : undefined;
  };

  const workersOpt = parseNumberOption(options.workers);
  const retriesOpt = parseNumberOption(options.retries);
  const serverTimeoutOpt = parseNumberOption(options.webserverTimeout);

  return {
    ...detectedConfig,
    storybookUrl,
    storybookPort: port,
    storybookCommand: options.command || detectedConfig.storybookCommand,
    workers: workersOpt ?? detectedConfig.workers,
    retries: retriesOpt ?? detectedConfig.retries,
    timeout: detectedConfig.timeout,
    serverTimeout: serverTimeoutOpt ?? detectedConfig.serverTimeout,
    headless: detectedConfig.headless,
    timezone: options.timezone || detectedConfig.timezone,
    locale: options.locale || detectedConfig.locale,
  };
}

// Helper function to wait for Storybook server to be ready
async function _waitForStorybookServer(url: string, timeout: number): Promise<void> {
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
          console.log(`✓ Storybook server is ready at ${url}`);
          return;
        } else {
          console.log(`Index.json not ready yet (${indexResponse.status})`);
        }
      } else {
        console.log(`Main page not ready yet (${mainResponse.status})`);
      }
    } catch (_error) {
      console.log(
        `Connection attempt ${attempt} failed:`,
        _error instanceof Error ? _error.message : String(_error),
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
async function runTests(options: CliOptions): Promise<void> {
  const _startedAt = Date.now();

  try {
    // Always use Playwright reporter path for proper webServer handling
    await runWithPlaywrightReporter(options);
  } catch (error) {
    console.log(chalk.red('Test execution failed'));
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    process.exit(1);
  }
}

function _formatDuration(durationMs: number): string {
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

async function runWithPlaywrightReporter(options: CliOptions): Promise<void> {
  // Get the main project directory where the CLI is installed
  const originalCwd = process.cwd();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const projectRoot = join(__dirname, '..', '..');

  const config = await createConfigFromOptions(options, originalCwd);
  const storybookCommand = config.storybookCommand || 'npm run storybook';

  // Optionally install Playwright browsers/deps for CI convenience
  if (options.installBrowsers !== undefined) {
    try {
      const raw = options.installBrowsers as unknown as string | boolean | undefined;
      let browser = 'chrome';
      if (typeof raw === 'string' && raw.trim().length > 0) {
        browser = raw.trim();
      }
      // If flag present without a value, Commander may set boolean true → default to chrome
      // Validate target
      const allowed = new Set([
        'chromium',
        'chromium-headless-shell',
        'chromium-tip-of-tree-headless-shell',
        'chrome',
        'chrome-beta',
        'msedge',
        'msedge-beta',
        'msedge-dev',
        '_bidiChromium',
        'firefox',
        'webkit',
        'all',
      ]);
      if (!allowed.has(browser)) {
        browser = 'chrome';
      }

      // Install system dependencies first if requested (Linux CI)
      if (options.installDeps) {
        const depTargets = browser === 'all' ? ['chromium', 'firefox', 'webkit'] : [browser];
        for (const t of depTargets) {
          await execa('npx', ['playwright', 'install-deps', t], { stdio: 'inherit' });
        }
      }

      // Install browsers
      if (browser === 'all') {
        await execa('npx', ['playwright', 'install', 'all'], { stdio: 'inherit' });
      } else {
        await execa('npx', ['playwright', 'install', browser], { stdio: 'inherit' });
      }
    } catch (installError) {
      console.error(
        chalk.red(
          `Failed to install browsers: ${installError instanceof Error ? installError.message : String(installError)}`,
        ),
      );
      process.exit(1);
    }
  }

  // Build the Storybook launch command while:
  // - Ensuring --ci is present if not already
  // - Appending --port only when not already specified in the provided command
  function buildStorybookLaunchCommand(baseCommand: string, targetPort: number): string {
    const hasPortFlagInCommand = /(\s|^)(-p|--port)(\s|=)/.test(baseCommand);
    // Only append --port when the user explicitly provided -p/--port on the CLI
    const userSpecifiedPortFlag = (() => {
      const argvJoined = process.argv.slice(2).join(' ');
      return /(\s|^)(-p|--port)(\s|=)/.test(argvJoined);
    })();

    const extraArgs: string[] = [];
    if (!hasPortFlagInCommand && userSpecifiedPortFlag && Number.isFinite(targetPort)) {
      extraArgs.push('--port', String(targetPort));
    }

    if (extraArgs.length === 0) return baseCommand;

    // If using npm/yarn/pnpm run, inject separator " -- " before args (unless already present)
    const isRunnerScript = /\b(npm|pnpm|yarn)\b.*\brun\b/.test(baseCommand);
    const hasSeparator = /\s--\s/.test(baseCommand);

    if (isRunnerScript && !hasSeparator) {
      return `${baseCommand} -- ${extraArgs.join(' ')}`;
    }
    // Otherwise append with a space
    return `${baseCommand} ${extraArgs.join(' ')}`;
  }

  const storybookLaunchCommand = buildStorybookLaunchCommand(
    storybookCommand,
    config.storybookPort,
  );

  // Set environment variables for Playwright
  process.env.PLAYWRIGHT_RETRIES = config.retries.toString();
  process.env.PLAYWRIGHT_WORKERS = config.workers.toString();
  process.env.PLAYWRIGHT_MAX_FAILURES = (options.maxFailures || 1).toString();
  // Snapshot updates are controlled exclusively by the `update` command
  process.env.STORYBOOK_URL = config.storybookUrl;
  process.env.PLAYWRIGHT_HEADLESS = config.headless ? 'true' : 'false';
  process.env.PLAYWRIGHT_TIMEZONE = config.timezone;
  process.env.PLAYWRIGHT_LOCALE = config.locale;
  if (options.reporter) process.env.PLAYWRIGHT_REPORTER = String(options.reporter);
  if (options.quiet) process.env.PLAYWRIGHT_REPORTER = 'src/reporters/filtered-reporter.ts';
  if (options.include) process.env.STORYBOOK_INCLUDE = String(options.include);
  if (options.exclude) process.env.STORYBOOK_EXCLUDE = String(options.exclude);
  if (options.grep) process.env.STORYBOOK_GREP = String(options.grep);
  // Pass test tuning knobs (parse numeric strings to handle underscores)
  if (options.navTimeout) {
    const parsed = parseInt(String(options.navTimeout).replace(/_/g, ''), 10);
    process.env.SVR_NAV_TIMEOUT = String(parsed);
  }
  if (options.waitTimeout) {
    const parsed = parseInt(String(options.waitTimeout).replace(/_/g, ''), 10);
    process.env.SVR_WAIT_TIMEOUT = String(parsed);
  }
  if (options.overlayTimeout) {
    const parsed = parseInt(String(options.overlayTimeout).replace(/_/g, ''), 10);
    process.env.SVR_OVERLAY_TIMEOUT = String(parsed);
  }
  if (options.stabilizeInterval) {
    const parsed = parseInt(String(options.stabilizeInterval).replace(/_/g, ''), 10);
    process.env.SVR_STABILIZE_INTERVAL = String(parsed);
  }
  if (options.stabilizeAttempts) {
    const parsed = parseInt(String(options.stabilizeAttempts).replace(/_/g, ''), 10);
    process.env.SVR_STABILIZE_ATTEMPTS = String(parsed);
  }
  if (options.notFoundCheck) {
    process.env.SVR_NOT_FOUND_CHECK = 'true';
  }
  if (options.notFoundRetryDelay) {
    const parsed = parseInt(String(options.notFoundRetryDelay).replace(/_/g, ''), 10);
    process.env.SVR_NOT_FOUND_RETRY_DELAY = String(parsed);
  }
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
      SVR_NAV_TIMEOUT: process.env.SVR_NAV_TIMEOUT,
      SVR_WAIT_TIMEOUT: process.env.SVR_WAIT_TIMEOUT,
      SVR_OVERLAY_TIMEOUT: process.env.SVR_OVERLAY_TIMEOUT,
      SVR_STABILIZE_INTERVAL: process.env.SVR_STABILIZE_INTERVAL,
      SVR_STABILIZE_ATTEMPTS: process.env.SVR_STABILIZE_ATTEMPTS,
      SVR_NOT_FOUND_CHECK: process.env.SVR_NOT_FOUND_CHECK,
      SVR_NOT_FOUND_RETRY_DELAY: process.env.SVR_NOT_FOUND_RETRY_DELAY,
    });

    // Log the effective Playwright config we will run with
    const effectivePlaywrightConfig = {
      testDir: join(projectRoot, 'src', 'tests'),
      outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR
        ? `${process.env.PLAYWRIGHT_OUTPUT_DIR}/results`
        : join(process.env.ORIGINAL_CWD || originalCwd, 'visual-regression', 'results'),
      reporter: 'list',
      retries: parseInt(process.env.PLAYWRIGHT_RETRIES || '0'),
      workers: parseInt(process.env.PLAYWRIGHT_WORKERS || '12'),
      maxFailures: parseInt(process.env.PLAYWRIGHT_MAX_FAILURES || '1'),
      updateSnapshots: process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS === 'true' ? 'all' : 'none',
      use: {
        baseURL: process.env.STORYBOOK_URL || 'http://localhost:9009',
        headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
        timezoneId: process.env.PLAYWRIGHT_TIMEZONE || 'Europe/London',
        locale: process.env.PLAYWRIGHT_LOCALE || 'en-GB',
        screenshot: 'only-on-failure',
      },
      webServer: process.env.STORYBOOK_COMMAND
        ? {
            command: process.env.STORYBOOK_COMMAND,
            url: `${(process.env.STORYBOOK_URL || 'http://localhost:9009').replace(/\/$/, '')}/index.json`,
            reuseExistingServer: true,
            timeout: parseInt(process.env.STORYBOOK_TIMEOUT || '120000'),
            cwd: process.env.STORYBOOK_CWD,
            stdout: 'inherit',
            stderr: 'inherit',
            env: {
              NODE_ENV: 'development',
              NODE_NO_WARNINGS: '1',
            },
            ignoreHTTPSErrors: true,
          }
        : undefined,
    };
    console.log(chalk.blue('🔍 Debug: Playwright config:'));
    console.log(
      chalk.gray(
        JSON.stringify(
          effectivePlaywrightConfig,
          (_key, value) => (typeof value === 'string' ? value : value),
          2,
        ),
      ),
    );
  }

  console.log('');
  console.log(chalk.bold('🚀 Starting Playwright visual regression tests'));
  console.log(
    `${chalk.dim('  •')} Storybook command: ${chalk.cyan(storybookLaunchCommand)} (${chalk.dim(
      storybookCommand,
    )})`,
  );
  console.log(`${chalk.dim('  •')} Working directory: ${chalk.cyan(originalCwd)}`);
  console.log(`${chalk.dim('  •')} Waiting for Storybook output...`);
  console.log('');

  try {
    const playwrightArgs = ['playwright', 'test'];

    // Use our config file instead of the project's config
    // Get the path to our config file relative to this CLI file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const projectRoot = join(__dirname, '..', '..');

    // Prefer new config location: dist/config.js then src/config.ts; keep legacy svr.config
    const configCandidates = [
      join(projectRoot, 'dist', 'config.js'),
      join(projectRoot, 'src', 'config.ts'),
      // legacy fallbacks
      join(projectRoot, 'svr.config.js'),
      join(projectRoot, 'dist', 'svr.config.js'),
      join(projectRoot, 'svr.config.ts'),
      join(projectRoot, 'dist', 'svr.config.ts'),
    ];
    const resolvedConfigPath = configCandidates.find((p) => existsSync(p)) || configCandidates[0];
    playwrightArgs.push('--config', resolvedConfigPath);

    // Always point tests to source tests to avoid missing specs in dist
    const testsDir = join(projectRoot, 'src', 'tests');

    // Resolve our minimal reporter path (used by default and in quiet mode)
    const customReporterCandidates = [
      join(projectRoot, 'dist', 'reporters', 'filtered-reporter.js'),
      join(projectRoot, 'src', 'reporters', 'filtered-reporter.ts'),
    ];
    const resolvedCustomReporter = customReporterCandidates.find((p) => existsSync(p));

    // Prefer our reporter unless user explicitly requested another or debug is enabled
    const shouldUseCustomReporter =
      !options.debug && !(options as CliOptions).reporter && !!resolvedCustomReporter;
    if (shouldUseCustomReporter && resolvedCustomReporter) {
      // Pass via CLI arg (highest precedence)
      playwrightArgs.push('--reporter', resolvedCustomReporter);
      // And also set env for redundancy/fallback
      process.env.PLAYWRIGHT_REPORTER = resolvedCustomReporter;
    }

    const child = execa('npx', playwrightArgs, {
      cwd: projectRoot, // Run from the main project directory where CLI is installed
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      // Force Playwright to use absolute paths and not create its own config
      env: {
        ...process.env,
        // Prevent Playwright from creating its own config in the wrong location
        PLAYWRIGHT_CONFIG_FILE: resolvedConfigPath,
        // Force Playwright to use the correct working directory
        PLAYWRIGHT_TEST_DIR: testsDir,
        PLAYWRIGHT_RETRIES: config.retries.toString(),
        PLAYWRIGHT_WORKERS: config.workers.toString(),
        PLAYWRIGHT_MAX_FAILURES: (options.maxFailures || 1).toString(),
        // Respect pre-set PLAYWRIGHT_UPDATE_SNAPSHOTS (set by `update` command)
        // Do not override here so updates actually occur
        STORYBOOK_URL: config.storybookUrl,
        PLAYWRIGHT_HEADLESS: config.headless ? 'true' : 'false',
        PLAYWRIGHT_TIMEZONE: config.timezone,
        PLAYWRIGHT_LOCALE: config.locale,
        PLAYWRIGHT_OUTPUT_DIR: join(originalCwd, options.output || 'visual-regression'),
        // Respect explicit reporter or debug; otherwise use our custom reporter if available
        PLAYWRIGHT_REPORTER: options.debug
          ? 'line'
          : (options as CliOptions).reporter
            ? String((options as CliOptions).reporter)
            : (shouldUseCustomReporter && resolvedCustomReporter) ||
              process.env.PLAYWRIGHT_REPORTER,
        // Surface a simple debug flag for tests to log helpful info like Story URLs
        SVR_DEBUG: options.debug ? 'true' : undefined,
        STORYBOOK_COMMAND: storybookLaunchCommand,
        STORYBOOK_CWD: originalCwd,
        STORYBOOK_TIMEOUT: config.serverTimeout.toString(),
        ORIGINAL_CWD: originalCwd,
      },
    });

    // stdio inherited; no manual piping required

    await child;

    console.log('');
    console.log(chalk.green('🎉 Visual regression tests completed successfully'));

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
  } catch {
    console.log('');
    console.error(chalk.red('💥 Test execution failed'));
    process.exit(1);
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
  .option(
    '--webserver-timeout <ms>',
    'Playwright webServer startup timeout in milliseconds',
    '120000',
  )
  .option('--retries <number>', 'Number of retries on failure', '0')
  .option('--max-failures <number>', 'Stop after N failures (<=0 disables)', '1')
  .option('--timezone <timezone>', 'Browser timezone', 'Europe/London')
  .option('--locale <locale>', 'Browser locale', 'en-GB')
  .option('--reporter <reporter>', 'Playwright reporter (list|line|dot|json|junit)')
  .option('--quiet', 'Suppress verbose failure output')
  .option('--debug', 'Enable debug logging')
  // Timing and stability options (ms / counts)
  .option('--nav-timeout <ms>', 'Navigation timeout (default 10000)', '10000')
  .option('--wait-timeout <ms>', 'Wait-for-element timeout (default 10000)')
  .option(
    '--overlay-timeout <ms>',
    'Timeout waiting for Storybook overlays to hide (default 5000)',
    '5000',
  )
  .option('--stabilize-interval <ms>', 'Interval between stability checks (default 200)', '200')
  .option('--stabilize-attempts <n>', 'Number of stability checks (default 20)', '20')
  .option('--include <patterns>', 'Include stories matching patterns (comma-separated)')
  .option('--exclude <patterns>', 'Exclude stories matching patterns (comma-separated)')
  .option('--grep <pattern>', 'Filter stories by regex pattern')
  .option(
    '--install-browsers [browser]',
    'Install Playwright browsers before running (chromium|firefox|webkit|all)',
    'chrome',
  )
  .option('--install-deps', 'Install system dependencies for browsers (Linux CI)')
  .option('--not-found-check', 'Enable Not Found content heuristic with retry')
  .option('--not-found-retry-delay <ms>', 'Delay between Not Found retries (default 200)', '200')
  .action(async (options) => runTests(options as CliOptions));

program
  .command('install-browsers')
  .description('Install Playwright browsers')
  .option('-b, --browser <browser>', 'Browser to install (chromium|firefox|webkit|all)', 'chromium')
  .action(async (options) => {
    const spinner = ora(`Installing ${(options as CliOptions).browser} browser...`).start();

    try {
      const { execSync } = await import('child_process');
      const browser =
        (options as CliOptions).browser === 'all' ? '' : (options as CliOptions).browser;
      execSync(`playwright install ${browser}`, { stdio: 'inherit' });

      spinner.succeed(`Successfully installed ${(options as CliOptions).browser} browser`);
    } catch (_error) {
      spinner.fail('Browser installation failed');
      console.error(chalk.red(_error instanceof Error ? _error.message : 'Unknown error'));
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
  .option(
    '--webserver-timeout <ms>',
    'Playwright webServer startup timeout in milliseconds',
    '120000',
  )
  .option('--retries <number>', 'Number of retries on failure', '0')
  .option('--max-failures <number>', 'Stop after N failures (<=0 disables)', '1')
  .option('--timezone <timezone>', 'Browser timezone', 'Europe/London')
  .option('--locale <locale>', 'Browser locale', 'en-GB')
  .option('--reporter <reporter>', 'Playwright reporter (list|line|dot|json|junit)')
  .option('--quiet', 'Suppress verbose failure output')
  .option('--debug', 'Enable debug logging')
  .option('--nav-timeout <ms>', 'Navigation timeout (default 10000)', '10000')
  .option('--wait-timeout <ms>', 'Wait-for-element timeout (default 30000)', '30000')
  .option(
    '--overlay-timeout <ms>',
    'Timeout waiting for Storybook overlays to hide (default 5000)',
    '5000',
  )
  .option('--stabilize-interval <ms>', 'Interval between stability checks (default 150)', '150')
  .option('--stabilize-attempts <n>', 'Number of stability checks (default 20)')
  .option('--include <patterns>', 'Include stories matching patterns (comma-separated)')
  .option('--exclude <patterns>', 'Exclude stories matching patterns (comma-separated)')
  .option('--grep <pattern>', 'Filter stories by regex pattern')
  .option(
    '--install-browsers [browser]',
    'Install Playwright browsers before running (chromium|firefox|webkit|all)',
    'chrome',
  )
  .option('--install-deps', 'Install system dependencies for browsers (Linux CI)')
  .option('--not-found-check', 'Enable Not Found content heuristic with retry')
  .option('--not-found-retry-delay <ms>', 'Delay between Not Found retries (default 200)', '200')
  .option('--missing-only', 'Only create snapshots for stories without existing baselines')
  .action(async (options) => {
    // Enable snapshot updates only via this command
    process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS = 'true';
    if ((options as CliOptions).missingOnly) {
      process.env.SVR_MISSING_ONLY = 'true';
    }
    if ((options as CliOptions).reporter)
      process.env.PLAYWRIGHT_REPORTER = String((options as CliOptions).reporter);
    await runTests(options as CliOptions);
  });

program.parse();
