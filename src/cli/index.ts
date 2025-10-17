#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import type { VisualRegressionConfig } from '../types/index.js';
import { createDefaultConfig } from '../config/defaultConfig.js';
import { StorybookConfigDetector } from '../core/StorybookConfigDetector.js';
import { execa } from 'execa';
import { fileURLToPath } from 'url';
import path, { dirname, join } from 'path';
import { loadUserConfig } from './config-loader.js';
import { initConfig, type ConfigFormat } from './init-config.js';
import type { RuntimeOptions } from '../runtime/runtime-options.js';

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
  resourceSettle?: string; // ms
  waitUntil?: string; // 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
  // Not found check configuration
  notFoundCheck?: boolean;
  notFoundRetryDelay?: string; // ms
  // Update behavior
  missingOnly?: boolean;
  clean?: boolean;
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
  const maxFailuresOpt = parseNumberOption(options.maxFailures) ?? userConfig.maxFailures;

  // Handle browser selection
  const browserOpt = options.browser;
  const allowedBrowsers = new Set(['chromium', 'firefox', 'webkit']);
  const browser =
    browserOpt && allowedBrowsers.has(browserOpt)
      ? (browserOpt as 'chromium' | 'firefox' | 'webkit')
      : detectedConfig.browser;

  const outputRoot = options.output
    ? path.isAbsolute(options.output)
      ? options.output
      : join(cwd, options.output)
    : join(cwd, 'visual-regression');
  const snapshotsDir = join(outputRoot, 'snapshots');
  const resultsDir = join(outputRoot, 'results');

  for (const dir of [outputRoot, snapshotsDir, resultsDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return {
    ...detectedConfig,
    storybookUrl,
    storybookPort: port,
    storybookCommand: options.command || undefined,
    workers: workersOpt ?? detectedConfig.workers,
    retries: retriesOpt ?? detectedConfig.retries,
    timeout: detectedConfig.timeout,
    serverTimeout: serverTimeoutOpt ?? detectedConfig.serverTimeout,
    maxFailures: maxFailuresOpt ?? detectedConfig.maxFailures,
    headless: detectedConfig.headless,
    timezone: options.timezone || detectedConfig.timezone,
    locale: options.locale || detectedConfig.locale,
    browser,
    snapshotPath: snapshotsDir,
    resultsPath: resultsDir,
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
  const projectRoot = join(__dirname, '..', '..');

  const config = await createConfigFromOptions(options, originalCwd);
  const storybookCommand = config.storybookCommand;

  const parsePatterns = (value?: string): string[] =>
    value
      ? value
          .split(',')
          .map((pattern) => pattern.trim())
          .filter(Boolean)
      : [];

  const parseNumber = (value: string | undefined, fallback: number): number => {
    if (typeof value === 'undefined') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const includePatterns = parsePatterns(options.include);
  const excludePatterns = parsePatterns(options.exclude);
  const grepPattern = options.grep?.trim() || undefined;
  const navTimeout = parseNumber(options.navTimeout, 10_000);
  const waitTimeout = parseNumber(options.waitTimeout, 30_000);
  const overlayTimeout = parseNumber(options.overlayTimeout, 5_000);
  const stabilizeInterval = parseNumber(options.stabilizeInterval, 150);
  const stabilizeAttempts = parseNumber(options.stabilizeAttempts, 20);
  const finalSettle = parseNumber(options.finalSettle, 500);
  const resourceSettle = parseNumber(options.resourceSettle, 100);
  const waitUntilCandidates = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
  const waitUntilInput = (options.waitUntil || '').toLowerCase();
  const waitUntilValue = waitUntilCandidates.has(waitUntilInput)
    ? (waitUntilInput as 'load' | 'domcontentloaded' | 'networkidle' | 'commit')
    : 'networkidle';
  const notFoundRetryDelay = parseNumber(options.notFoundRetryDelay, 200);
  const debugEnabled = Boolean(options.debug);
  const updateSnapshots = Boolean(options.updateSnapshots);
  const hideTimeEstimates = Boolean(options.hideTimeEstimates);
  const hideSpinners = Boolean(options.hideSpinners);
  const printUrls = Boolean(options.printUrls);
  const missingOnly = Boolean(options.missingOnly);
  const clean = Boolean(options.clean);
  const notFoundCheck = Boolean(options.notFoundCheck);
  const isCIEnvironment = !process.stdout.isTTY;

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
  let finalStorybookCommand = storybookLaunchCommand;

  // Check if Storybook is already running if we have a command
  if (storybookLaunchCommand) {
    const storybookIndexUrl = `${config.storybookUrl.replace(/\/$/, '')}/index.json`;
    console.log(`🔍 Checking if Storybook is already running at: ${storybookIndexUrl}`);

    try {
      const response = await fetch(storybookIndexUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (response.ok) {
        console.log(`🔍 Storybook is already running, skipping webserver startup`);
        finalStorybookCommand = undefined;
      } else {
        console.log(`🔍 Storybook not accessible (${response.status}), will start webserver`);
      }
    } catch (error) {
      console.log(
        `🔍 Storybook not accessible (${error instanceof Error ? error.message : 'unknown error'}), will start webserver`,
      );
    }
  }

  const runtimeConfig: VisualRegressionConfig = {
    ...config,
    storybookCommand: finalStorybookCommand,
  };

  // Calculate test timeout: sum of all possible waits + buffer
  // This prevents "Test timeout exceeded while setting up 'page'" errors
  const calculatedTestTimeout =
    navTimeout * 2 + // Initial navigation + possible retry (e.g., 'load' -> 'networkidle')
    10000 + // Explicit font loading wait
    waitTimeout + // Wait for #storybook-root
    overlayTimeout + // Wait for overlays
    stabilizeInterval * stabilizeAttempts + // Stabilization attempts
    finalSettle + // Final settle time
    10000 + // Additional waits in waitForLoadingSpinners
    5000 + // Additional checks (error page, content visibility)
    20000; // Buffer for screenshot capture and other operations

  // Apply 1.5x safety multiplier for edge cases and use a minimum of 60 seconds
  const testTimeout = Math.max(Math.ceil(calculatedTestTimeout * 1.5), 60000);

  const outputDir = path.dirname(runtimeConfig.resultsPath);
  const runtimeOptions: RuntimeOptions = {
    originalCwd,
    storybookUrl: runtimeConfig.storybookUrl,
    outputDir,
    visualRegression: runtimeConfig,
    include: includePatterns,
    exclude: excludePatterns,
    grep: grepPattern,
    navTimeout,
    waitTimeout,
    overlayTimeout,
    stabilizeInterval,
    stabilizeAttempts,
    finalSettle,
    resourceSettle,
    waitUntil: waitUntilValue,
    missingOnly,
    clean,
    notFoundCheck,
    notFoundRetryDelay,
    debug: debugEnabled,
    updateSnapshots,
    hideTimeEstimates,
    hideSpinners,
    printUrls,
    isCI: isCIEnvironment,
    testTimeout,
  };

  const runtimeOptionsPath = join(projectRoot, 'dist', 'runtime-options.json');
  mkdirSync(path.dirname(runtimeOptionsPath), { recursive: true });
  writeFileSync(runtimeOptionsPath, JSON.stringify(runtimeOptions, null, 2), 'utf8');

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

    if (options.updateSnapshots) {
      playwrightArgs.push('--update-snapshots');
    }

    // Use our config file instead of the project's config
    // Get the path to our config file relative to this CLI file
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

    playwrightArgs.push('--workers', String(runtimeConfig.workers));
    playwrightArgs.push('--retries', String(runtimeConfig.retries));
    playwrightArgs.push('--max-failures', String(runtimeConfig.maxFailures));

    // Resolve our minimal reporter path (used by default and in quiet mode)
    const customReporterCandidates = [
      join(projectRoot, 'dist', 'reporters', 'filtered-reporter.js'),
      join(projectRoot, 'src', 'reporters', 'filtered-reporter.ts'),
    ];
    const resolvedCustomReporter = customReporterCandidates.find((p) => existsSync(p));
    const silentReporterCandidates = [
      join(projectRoot, 'dist', 'reporters', 'silent-reporter.js'),
      join(projectRoot, 'src', 'reporters', 'silent-reporter.ts'),
    ];
    const resolvedSilentReporter = silentReporterCandidates.find((p) => existsSync(p));
    const useSilentReporter =
      typeof runtimeConfig.serverTimeout === 'number' &&
      runtimeConfig.serverTimeout > 0 &&
      runtimeConfig.serverTimeout < 1000 &&
      resolvedSilentReporter;

    let reporterArg: string | undefined;
    if (useSilentReporter) {
      reporterArg = resolvedSilentReporter;
    } else if ((options as CliOptions).reporter) {
      reporterArg = String((options as CliOptions).reporter);
    } else if (debugEnabled) {
      reporterArg = 'line';
    } else if (resolvedCustomReporter) {
      reporterArg = resolvedCustomReporter;
    }

    if (reporterArg) {
      playwrightArgs.push('--reporter', reporterArg);
    }

    const child = execa('npx', playwrightArgs, {
      cwd: projectRoot, // Run from the tool's project root so Playwright finds our tests/config
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: process.env,
    });

    // stdio inherited; no manual piping required

    await child;

    console.log('');
    console.log(chalk.green('🎉 Visual regression tests completed successfully'));

    if (options.updateSnapshots) {
      const resultsDir = runtimeConfig.resultsPath;
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
      if (debugEnabled) {
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
    'Maximum time to wait for page navigation (page.goto). Increase for slow-loading stories or networks.',
    '10000',
  )
  .option(
    '--wait-timeout <ms>',
    'Maximum time for wait operations (selectors, resource loading). Increase for stories with many resources.',
    '10000',
  )
  .option(
    '--overlay-timeout <ms>',
    "Maximum time to wait for Storybook's 'preparing' overlays to hide before force-hiding them.",
    '5000',
  )
  .option(
    '--stabilize-interval <ms>',
    'Interval between visual stability checks to ensure content has stopped changing.',
    '200',
  )
  .option(
    '--stabilize-attempts <n>',
    'Number of stability checks to perform. Increase for animated/dynamic stories.',
    '20',
  )
  .option(
    '--final-settle <ms>',
    'Final delay after all readiness checks pass before taking screenshot. Increase for late animations.',
    '500',
  )
  .option(
    '--resource-settle <ms>',
    'Time after a resource finishes loading before considering all resources settled. Increase for slow networks.',
    '100',
  )
  .option(
    '--wait-until <state>',
    "Navigation strategy: 'domcontentloaded' (fastest), 'networkidle' (default, stable), 'load' (wait for all resources), 'commit' (earliest).",
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
  .option('--not-found-check', 'Enable detection and retry for "Not Found" / 404 pages')
  .option('--not-found-retry-delay <ms>', 'Delay between "Not Found" retries', '200')
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
    'Maximum time to wait for page navigation (page.goto). Increase for slow-loading stories or networks.',
    '10000',
  )
  .option(
    '--wait-timeout <ms>',
    'Max time waits can block (selectors/readiness checks). Not per-test timeout; increase for heavy stories.',
    '30000',
  )
  .option(
    '--overlay-timeout <ms>',
    "Maximum time to wait for Storybook's 'preparing' overlays to hide before force-hiding them.",
    '5000',
  )
  .option(
    '--stabilize-interval <ms>',
    'Interval between visual stability checks (DOM/layout). Lower is stricter, higher is faster.',
    '150',
  )
  .option(
    '--stabilize-attempts <n>',
    'Number of stability checks to perform. Increase for animated/dynamic stories.',
    '20',
  )
  .option(
    '--final-settle <ms>',
    'Final delay after all readiness checks pass before taking screenshot. Increase for late animations.',
    '500',
  )
  .option(
    '--resource-settle <ms>',
    'Time after a resource finishes loading before considering all resources settled. Increase for slow networks.',
    '100',
  )
  .option(
    '--wait-until <state>',
    "Navigation strategy: 'domcontentloaded' (fastest), 'networkidle' (default, stable), 'load' (wait for all resources), 'commit' (earliest).",
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
  .option('--not-found-check', 'Enable detection and retry for "Not Found" / 404 pages')
  .option('--not-found-retry-delay <ms>', 'Delay between "Not Found" retries', '200')
  .option('--missing-only', 'Only create snapshots that do not already exist (skip existing baselines)')
  .option(
    '--no-clean',
    'Keep existing snapshots instead of deleting them before update (default: clean before update)',
  )
  .action(async (options) => {
    // Mark option so we can pass update mode to tests
    (options as CliOptions).updateSnapshots = true;
    // Set clean to true by default for update command (unless --no-clean is passed)
    if (options.clean === undefined) {
      (options as CliOptions).clean = true;
    }
    // missingOnly behavior handled inside tests via file presence
    await runTests(options as CliOptions);
  });

program.parse();
