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
import { loadUserConfig } from './config-loader.js';
import { initConfig, type ConfigFormat } from './init-config.js';

const program = new Command();

type CliOptions = {
  config?: string;
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
  hideTimeEstimates?: boolean;
  hideSpinners?: boolean;
  output?: string;
  updateSnapshots?: boolean;
  browser?: string;
  printUrls?: boolean;
  // Timeouts and stability tuning
  navTimeout?: string; // ms
  waitTimeout?: string; // ms
  overlayTimeout?: string; // ms
  stabilizeInterval?: string; // ms
  stabilizeAttempts?: string; // count
  finalSettle?: string; // ms
  waitUntil?: string; // 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
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
  // Load user config file (if exists)
  const userConfig = await loadUserConfig(cwd, options.config);

  const defaultConfig = createDefaultConfig();
  const detector = new StorybookConfigDetector(cwd);

  // Detect Storybook configuration from the project
  const detectedConfig = await detector.detectAndMergeConfig(defaultConfig);

  // If no explicit command is provided, don't use the detected command
  if (!options.command) {
    detectedConfig.storybookCommand = undefined;
  }

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

  // Merge configs: CLI options > user config > detected config > defaults
  // Priority: CLI flags override user config file, which overrides detected config
  const workersOpt = parseNumberOption(options.workers) ?? userConfig.workers;
  const retriesOpt = parseNumberOption(options.retries) ?? userConfig.retries;
  const serverTimeoutOpt =
    parseNumberOption(options.webserverTimeout) ?? userConfig.webserverTimeout;

  // Use silent reporter for very short webserver timeouts to prevent confusing output
  if (serverTimeoutOpt && serverTimeoutOpt < 1000) {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const silentReporterPath = join(currentDir, '..', 'reporters', 'silent-reporter.js');
    process.env.PLAYWRIGHT_REPORTER = silentReporterPath;
  }

  // Handle browser selection
  const browserOpt = options.browser;
  const allowedBrowsers = new Set(['chromium', 'firefox', 'webkit']);
  const browser =
    browserOpt && allowedBrowsers.has(browserOpt)
      ? (browserOpt as 'chromium' | 'firefox' | 'webkit')
      : detectedConfig.browser;

  return {
    ...detectedConfig,
    storybookUrl,
    storybookPort: port,
    storybookCommand: options.command || undefined,
    workers: workersOpt ?? detectedConfig.workers,
    retries: retriesOpt ?? detectedConfig.retries,
    timeout: detectedConfig.timeout,
    serverTimeout: serverTimeoutOpt ?? detectedConfig.serverTimeout,
    headless: detectedConfig.headless,
    timezone: options.timezone || detectedConfig.timezone,
    locale: options.locale || detectedConfig.locale,
    browser,
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

// Init command - create default config file
program
  .command('init')
  .description('Create a default config file')
  .option('-f, --format <format>', 'Config format (js|ts|json)', 'js')
  .option('--force', 'Overwrite existing config file')
  .action((options: { format?: string; force?: boolean }) => {
    const format = (options.format || 'js') as ConfigFormat;
    if (!['js', 'ts', 'json'].includes(format)) {
      console.error(chalk.red(`Invalid format: ${format}. Use js, ts, or json`));
      process.exit(1);
    }
    initConfig(process.cwd(), format, options.force || false);
  });

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

  const config = await createConfigFromOptions(options, originalCwd);
  const storybookCommand = config.storybookCommand;

  // Optionally install Playwright browsers/deps for CI convenience
  // Only install if the --install-browsers flag was explicitly provided
  if (process.argv.includes('--install-browsers')) {
    try {
      const raw = options.installBrowsers as unknown as string | boolean | undefined;
      let browser = 'chromium';
      if (typeof raw === 'string' && raw.trim().length > 0) {
        browser = raw.trim();
      }
      // If flag present without a value, Commander may set boolean true → default to chromium
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
        browser = 'chromium';
      }

      // Install browsers (with system dependencies if requested)
      const args = ['playwright', 'install'];

      if (options.installDeps) {
        args.push('--with-deps');
      }

      if (browser === 'all') {
        // Install all browsers at once
        await execa('npx', args, { stdio: 'inherit' });
      } else {
        // Install specific browser
        args.push(browser);
        await execa('npx', args, { stdio: 'inherit' });
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

  const storybookLaunchCommand = storybookCommand
    ? buildStorybookLaunchCommand(storybookCommand, config.storybookPort)
    : undefined;

  // Set environment variables for Playwright
  process.env.PLAYWRIGHT_RETRIES = config.retries.toString();
  process.env.PLAYWRIGHT_WORKERS = config.workers.toString();
  process.env.PLAYWRIGHT_MAX_FAILURES = (options.maxFailures || 1).toString();
  // Snapshot updates are controlled exclusively by the `update` command
  process.env.STORYBOOK_URL = config.storybookUrl;
  process.env.PLAYWRIGHT_HEADLESS = config.headless ? 'true' : 'false';
  process.env.PLAYWRIGHT_TIMEZONE = config.timezone;
  process.env.PLAYWRIGHT_LOCALE = config.locale;
  process.env.PLAYWRIGHT_BROWSER = config.browser;
  if (options.reporter) process.env.PLAYWRIGHT_REPORTER = String(options.reporter);
  if (options.quiet) process.env.PLAYWRIGHT_REPORTER = 'src/reporters/filtered-reporter.ts';
  if (options.include) process.env.STORYBOOK_INCLUDE = String(options.include);
  if (options.exclude) process.env.STORYBOOK_EXCLUDE = String(options.exclude);
  if (options.grep) process.env.STORYBOOK_GREP = String(options.grep);
  // Only set STORYBOOK_COMMAND if a command was provided (not just the default)
  // AND if the URL is not already accessible
  if (storybookLaunchCommand) {
    // Check if Storybook is already running at the target URL
    const storybookIndexUrl = `${config.storybookUrl.replace(/\/$/, '')}/index.json`;
    console.log(`🔍 Checking if Storybook is already running at: ${storybookIndexUrl}`);

    try {
      const response = await fetch(storybookIndexUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (response.ok) {
        console.log(`🔍 Storybook is already running, skipping webserver startup`);
        // Don't set STORYBOOK_COMMAND if the server is already running
      } else {
        console.log(`🔍 Storybook not accessible (${response.status}), will start webserver`);
        process.env.STORYBOOK_COMMAND = storybookLaunchCommand;
      }
    } catch (error) {
      console.log(
        `🔍 Storybook not accessible (${error instanceof Error ? error.message : 'unknown error'}), will start webserver`,
      );
      process.env.STORYBOOK_COMMAND = storybookLaunchCommand;
    }
  }
  process.env.STORYBOOK_CWD = originalCwd; // Use original working directory for Storybook
  process.env.STORYBOOK_TIMEOUT = config.serverTimeout.toString();
  process.env.ORIGINAL_CWD = originalCwd;

  console.log('');
  console.log(chalk.bold('🚀 Starting Playwright visual regression tests'));
  if (storybookCommand) {
    console.log(
      `${chalk.dim('  •')} Storybook command: ${chalk.cyan(storybookLaunchCommand)} (${chalk.dim(
        storybookCommand,
      )})`,
    );
    console.log(`${chalk.dim('  •')} Working directory: ${chalk.cyan(originalCwd)}`);
    console.log(`${chalk.dim('  •')} Waiting for Storybook output...`);
  } else {
    console.log(
      `${chalk.dim('  •')} Using existing Storybook server at ${chalk.cyan(config.storybookUrl)}`,
    );
    console.log(`${chalk.dim('  •')} Working directory: ${chalk.cyan(originalCwd)}`);
  }
  console.log('');

  try {
    const playwrightArgs = ['playwright', 'test'];
    if (
      process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS === 'true' ||
      (options as CliOptions).updateSnapshots
    ) {
      playwrightArgs.push('--update-snapshots=all');
    }

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
    // Use absolute path to ensure Playwright uses our config, not the project's config
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
    // Don't use custom reporter if silent reporter is set
    const shouldUseCustomReporter =
      !options.debug &&
      !(options as CliOptions).reporter &&
      !!resolvedCustomReporter &&
      !process.env.PLAYWRIGHT_REPORTER?.includes('silent-reporter');
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
        PLAYWRIGHT_MAX_FAILURES: (options.maxFailures || 10).toString(),
        // Respect pre-set PLAYWRIGHT_UPDATE_SNAPSHOTS (set by `update` command)
        // Do not override here so updates actually occur
        STORYBOOK_URL: config.storybookUrl,
        PLAYWRIGHT_HEADLESS: config.headless ? 'true' : 'false',
        PLAYWRIGHT_TIMEZONE: config.timezone,
        PLAYWRIGHT_LOCALE: config.locale,
        PLAYWRIGHT_BROWSER: config.browser,
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
        // Only set STORYBOOK_COMMAND if a command was provided (not just the default)
        STORYBOOK_COMMAND: storybookLaunchCommand || undefined,
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
  } catch (error) {
    console.log('');
    // Only show error message if it's not an aborted execution
    // Exit code 130 typically indicates SIGINT (Ctrl+C) - user interruption
    const exitCode = (error as { exitCode?: number })?.exitCode;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if this is just a warning or non-critical issue
    const isNonCriticalError =
      errorMessage.includes('Warning:') ||
      errorMessage.includes('NO_COLOR') ||
      errorMessage.includes('deprecated') ||
      errorMessage.includes('deprecation') ||
      exitCode === 0; // Exit code 0 means success

    if (exitCode !== 130) {
      // Debug: Log the actual error message to help identify patterns (only in debug mode)
      if (process.env.SVR_DEBUG === 'true') {
        console.error(chalk.gray(`Debug - Error message: "${errorMessage}"`));
        console.error(chalk.gray(`Debug - Error object:`, error));
      }

      // Check for specific error types and show appropriate messages
      const isWebserverTimeout =
        errorMessage.includes('Storybook server did not start within') ||
        (errorMessage.includes('webServer') && errorMessage.includes('timeout')) ||
        (errorMessage.includes('WebServer') && errorMessage.includes('timeout')) ||
        errorMessage.includes('server startup timeout') ||
        (errorMessage.includes('Timed out waiting') && errorMessage.includes('config.webServer'));

      if (isWebserverTimeout) {
        // Show prominent webserver timeout message
        console.error(
          chalk.red.bold('═══════════════════════════════════════════════════════════════'),
        );
        console.error(chalk.red.bold('⏰ WEBSERVER TIMEOUT - STORYBOOK FAILED TO START'));
        console.error(
          chalk.red.bold('═══════════════════════════════════════════════════════════════'),
        );
        console.error('');
        console.error(chalk.yellow('💡 Try increasing the timeout with --webserver-timeout <ms>'));
        console.error(
          chalk.yellow('💡 Or start Storybook manually and run tests without --command'),
        );
        console.error('');
        console.error(
          chalk.red.bold("⚠️  IGNORE THE TEST OUTPUT ABOVE - IT'S NOT RELEVANT TO THIS ERROR"),
        );
        console.error('');
      } else if (
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('connection refused')
      ) {
        console.error(chalk.red.bold('🔌 Connection refused - Storybook server not accessible'));
        console.error(chalk.yellow('💡 Make sure Storybook is running at the specified URL'));
      } else if (errorMessage.includes('timeout')) {
        console.error(chalk.red.bold('⏰ Operation timed out'));
      } else if (isNonCriticalError) {
        // Don't show error message for non-critical issues
        console.log(chalk.green('🎉 Visual regression tests completed successfully'));
      } else {
        console.error(chalk.red.bold('💥 Test execution failed'));
      }
    }

    // Only exit with error code for critical failures, not warnings
    if (isNonCriticalError) {
      process.exit(0); // Success
    } else {
      process.exit(exitCode || 1); // Error
    }
  }
}

program
  .command('test')
  .description('Run visual regression tests')
  .option('--config <path>', 'Path to config file')
  .option('-p, --port <port>', 'Storybook server port', '9009')
  .option('-u, --url <url>', 'Storybook server URL', 'http://localhost')
  .option('-o, --output <dir>', 'Output directory for results', 'visual-regression')
  .option('-w, --workers <number>', 'Number of parallel workers', '12')
  .option('-c, --command <command>', 'Command to start Storybook server')
  .option(
    '--webserver-timeout <ms>',
    'Playwright webServer startup timeout in milliseconds',
    '120000',
  )
  .option('--retries <number>', 'Number of retries on failure', '0')
  .option('--max-failures <number>', 'Stop after N failures (<=0 disables)', '10')
  .option('--timezone <timezone>', 'Browser timezone', 'Europe/London')
  .option('--locale <locale>', 'Browser locale', 'en-GB')
  .option('--reporter <reporter>', 'Playwright reporter (list|line|dot|json|junit)')
  .option('--quiet', 'Suppress verbose failure output')
  .option('--debug', 'Enable debug logging')
  .option('--print-urls', 'Show story URLs inline with test results')
  .option('--hide-time-estimates', 'Hide time estimates in progress display')
  .option('--hide-spinners', 'Hide progress spinners (useful for CI)')
  .option('--browser <browser>', 'Browser to use (chromium|firefox|webkit)', 'chromium')
  // Timing and stability options (ms / counts)
  .option(
    '--nav-timeout <ms>',
    'Max time to wait for page.goto() (story load) before failing. Lower for speed; raise for slow hosts.',
    '10000',
  )
  .option(
    '--wait-timeout <ms>',
    'Max time waits can block (selectors/readiness checks). Not per-test timeout; use to accommodate heavy stories.',
    '10000',
  )
  .option(
    '--overlay-timeout <ms>',
    "Time to wait for Storybook's preparing overlays to hide before we force-hide them.",
    '5000',
  )
  .option(
    '--stabilize-interval <ms>',
    'Interval between visual stability checks (DOM/layout). Lower is stricter, higher is faster.',
    '200',
  )
  .option(
    '--stabilize-attempts <n>',
    'Number of stability checks before we proceed. Increase for flakiness; decrease for speed.',
    '20',
  )
  .option(
    '--final-settle <ms>',
    'A small additional wait after readiness to allow last paints/animations to settle.',
    '500',
  )
  .option(
    '--wait-until <state>',
    "Navigation completion strategy: 'domcontentloaded' (fast), 'load' (full load), 'networkidle' (most stable, can hang on polling), 'commit' (earliest).",
    'networkidle',
  )
  .option('--include <patterns>', 'Include stories matching patterns (comma-separated)')
  .option('--exclude <patterns>', 'Exclude stories matching patterns (comma-separated)')
  .option('--grep <pattern>', 'Filter stories by regex pattern')
  .option(
    '--install-browsers [browser]',
    'Install Playwright browsers before running (chromium|firefox|webkit|all)',
    'chromium',
  )
  .option('--install-deps', 'Install system dependencies for browsers (Linux CI)')
  .option('--not-found-check', 'Enable Not Found content heuristic with retry')
  .option('--not-found-retry-delay <ms>', 'Delay between Not Found retries', '200')
  .action(async (options) => runTests(options as CliOptions));

program
  .command('install-browsers')
  .description('Install Playwright browsers')
  .option('-b, --browser <browser>', 'Browser to install (chromium|firefox|webkit|all)', 'chromium')
  .action(async (options) => {
    const browser = (options as CliOptions).browser || 'chromium';
    const spinner = ora(`Installing ${browser} browser...`).start();

    try {
      // Install browsers (with system dependencies if requested)
      const args = ['playwright', 'install'];

      if (browser === 'all') {
        // Install all browsers at once
        await execa('npx', args, { stdio: 'inherit' });
      } else {
        // Install specific browser
        args.push(browser);
        await execa('npx', args, { stdio: 'inherit' });
      }

      spinner.succeed(`Successfully installed ${browser} browser`);
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
  .option('--config <path>', 'Path to config file')
  .option('-p, --port <port>', 'Storybook server port', '9009')
  .option('-u, --url <url>', 'Storybook server URL', 'http://localhost')
  .option('-o, --output <dir>', 'Output directory for results', 'visual-regression')
  .option('-w, --workers <number>', 'Number of parallel workers', '12')
  .option('-c, --command <command>', 'Command to start Storybook server')
  .option(
    '--webserver-timeout <ms>',
    'Playwright webServer startup timeout in milliseconds',
    '120000',
  )
  .option('--retries <number>', 'Number of retries on failure', '0')
  .option('--max-failures <number>', 'Stop after N failures (<=0 disables)', '10')
  .option('--timezone <timezone>', 'Browser timezone', 'Europe/London')
  .option('--locale <locale>', 'Browser locale', 'en-GB')
  .option('--reporter <reporter>', 'Playwright reporter (list|line|dot|json|junit)')
  .option('--quiet', 'Suppress verbose failure output')
  .option('--debug', 'Enable debug logging')
  .option('--print-urls', 'Show story URLs inline with test results')
  .option('--hide-time-estimates', 'Hide time estimates in progress display')
  .option('--hide-spinners', 'Hide progress spinners (useful for CI)')
  .option('--browser <browser>', 'Browser to use (chromium|firefox|webkit)', 'chromium')
  .option(
    '--nav-timeout <ms>',
    'Max time to wait for page.goto() (story load) before failing. Lower for speed; raise for slow hosts.',
    '10000',
  )
  .option(
    '--wait-timeout <ms>',
    'Max time waits can block (selectors/readiness checks). Not per-test timeout; increase for heavy stories.',
    '30000',
  )
  .option(
    '--overlay-timeout <ms>',
    "Time to wait for Storybook's preparing overlays to hide before we force-hide them.",
    '5000',
  )
  .option(
    '--stabilize-interval <ms>',
    'Interval between visual stability checks (DOM/layout). Lower is stricter, higher is faster.',
    '150',
  )
  .option(
    '--stabilize-attempts <n>',
    'Number of stability checks before we proceed. Increase for flakiness; decrease for speed.',
    '20',
  )
  .option(
    '--final-settle <ms>',
    'A small additional wait after readiness to allow last paints/animations to settle.',
    '500',
  )
  .option(
    '--wait-until <state>',
    "Navigation completion strategy: 'domcontentloaded' (fast), 'load' (full load), 'networkidle' (most stable, can hang on polling), 'commit' (earliest).",
    'networkidle',
  )
  .option('--include <patterns>', 'Include stories matching patterns (comma-separated)')
  .option('--exclude <patterns>', 'Exclude stories matching patterns (comma-separated)')
  .option('--grep <pattern>', 'Filter stories by regex pattern')
  .option(
    '--install-browsers [browser]',
    'Install Playwright browsers before running (chromium|firefox|webkit|all)',
    'chromium',
  )
  .option('--install-deps', 'Install system dependencies for browsers (Linux CI)')
  .option('--not-found-check', 'Enable Not Found content heuristic with retry')
  .option('--not-found-retry-delay <ms>', 'Delay between Not Found retries', '200')
  .option('--missing-only', 'Only create snapshots for stories without existing baselines')
  .action(async (options) => {
    // Enable snapshot updates only via this command
    process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS = 'true';
    // Mark option so we can also pass an explicit Playwright flag later
    (options as CliOptions).updateSnapshots = true;
    // missingOnly behavior handled inside tests via file presence
    if ((options as CliOptions).reporter)
      process.env.PLAYWRIGHT_REPORTER = String((options as CliOptions).reporter);
    await runTests(options as CliOptions);
  });

program.parse();
