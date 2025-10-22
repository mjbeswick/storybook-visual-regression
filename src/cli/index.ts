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
import { loadUserConfig, saveUserConfig, getDefaultConfigPath } from './config-loader.js';
import type { RuntimeOptions } from '../runtime/runtime-options.js';
import { readFileSync } from 'fs';

// Utility function to replace host.docker.internal with localhost for better accessibility in Docker environments
function replaceDockerHostInUrl(url: string): string {
  const isDockerEnvironment = Boolean(
    process.env.DOCKER_CONTAINER || process.env.CONTAINER || existsSync('/.dockerenv'),
  );

  if (isDockerEnvironment && url.includes('host.docker.internal')) {
    return url.replace(/host\.docker\.internal/g, 'localhost');
  }

  return url;
}

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '../../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

const program = new Command();

program
  .name('storybook-visual-regression')
  .description('Visual regression testing tool for Storybook')
  .version(packageJson.version)
  .option('--config <path>', 'Path to config file')
  .option('-u, --url <url>', 'Storybook server URL', 'http://localhost:9009')
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
  .option('--storybook', 'Output results as JSON for Storybook addon consumption', false)
  .option('--print-urls', 'Show story URLs inline with test results')
  .option('--hide-time-estimates', 'Hide time estimates in progress display')
  .option('--hide-spinners', 'Hide progress spinners (useful for CI)')
  .option('--browser <browser>', 'Browser to use (chromium|firefox|webkit)', 'chromium')
  .option('--threshold <number>', 'Screenshot comparison threshold (0.0-1.0)', '0.2')
  .option('--max-diff-pixels <number>', 'Maximum number of pixels that can differ', '0')
  .option('--full-page', 'Capture full-page screenshots (boolean)')
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
    '100',
  )
  .option(
    '--resource-settle <ms>',
    'Time after a resource finishes loading before considering all resources settled. Increase for slow networks.',
    '100',
  )
  .option(
    '--wait-until <state>',
    "Navigation strategy: 'domcontentloaded' (fastest), 'networkidle' (stable), 'load' (default, wait for all resources), 'commit' (earliest).",
    'load',
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
  .option('--update', 'Update visual regression snapshots (create new baselines)')
  .option(
    '--missing-only',
    'Only create snapshots that do not already exist (skip existing baselines)',
  )
  .option('--save-config', 'Save CLI options to config file for future use')
  .action(async (options) => {
    const cliOptions = options as CliOptions;

    // Handle update mode
    if (cliOptions.update) {
      cliOptions.updateSnapshots = true;
      // Set clean to true by default for update mode
      if (cliOptions.clean === undefined) {
        cliOptions.clean = true;
      }
    }

    await runTests(cliOptions);
  });

type CliOptions = {
  config?: string;
  url?: string;
  command?: string;
  workers?: string;
  retries?: string;
  webserverTimeout?: string;
  timezone?: string;
  locale?: string;
  maxFailures?: string;
  reporter?: string;
  storybook?: boolean;
  quiet?: boolean;
  include?: string;
  exclude?: string;
  grep?: string;
  debug?: boolean;
  hideTimeEstimates?: boolean;
  hideSpinners?: boolean;
  output?: string;
  updateSnapshots?: boolean;
  update?: boolean; // new --update flag
  browser?: string;
  printUrls?: boolean;
  // Screenshot configuration
  threshold?: string;
  maxDiffPixels?: string;
  fullPage?: boolean;
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
  // Config persistence
  saveConfig?: boolean;
};

async function createConfigFromOptions(
  options: CliOptions,
  cwd: string,
): Promise<VisualRegressionConfig> {
  // Load user config file (if exists)
  const userConfig = await loadUserConfig(cwd, options.config);
  // Persist overrides back to visual-regression/config.json when flags are explicitly provided
  const argvJoined = process.argv.slice(2).join(' ');
  const hasArg = (...flags: string[]) =>
    flags.some((f) => new RegExp(`(\\s|^)${f}(\\s|=)`).test(argvJoined));
  const updatedUserConfig = { ...userConfig } as Record<string, unknown>;
  let didUpdate = false;

  const setIf = (present: boolean, key: string, value: unknown) => {
    if (!present) return;
    if (updatedUserConfig[key] !== value) {
      updatedUserConfig[key] = value;
      didUpdate = true;
    }
  };

  // Basic/string options
  setIf(hasArg('--url', '-u'), 'url', options.url);
  setIf(hasArg('--command', '-c'), 'command', options.command);
  setIf(hasArg('--reporter'), 'reporter', options.reporter);
  setIf(hasArg('--browser'), 'browser', options.browser);
  setIf(hasArg('--timezone'), 'timezone', options.timezone);
  setIf(hasArg('--locale'), 'locale', options.locale);
  setIf(hasArg('--grep'), 'grep', options.grep);
  setIf(hasArg('--output', '-o'), 'output', options.output);
  setIf(hasArg('--wait-until'), 'waitUntil', options.waitUntil);

  // Numeric options
  const num = (v?: string) => (typeof v === 'string' ? parseInt(v, 10) : undefined);
  const floatNum = (v?: string) => (typeof v === 'string' ? parseFloat(v) : undefined);
  setIf(hasArg('--workers', '-w'), 'workers', num(options.workers));
  setIf(hasArg('--retries'), 'retries', num(options.retries));
  setIf(hasArg('--max-failures'), 'maxFailures', num(options.maxFailures));
  setIf(hasArg('--nav-timeout'), 'navTimeout', num(options.navTimeout));
  setIf(hasArg('--wait-timeout'), 'waitTimeout', num(options.waitTimeout));
  setIf(hasArg('--overlay-timeout'), 'overlayTimeout', num(options.overlayTimeout));
  setIf(hasArg('--webserver-timeout'), 'webserverTimeout', num(options.webserverTimeout));
  setIf(hasArg('--stabilize-interval'), 'stabilizeInterval', num(options.stabilizeInterval));
  setIf(hasArg('--stabilize-attempts'), 'stabilizeAttempts', num(options.stabilizeAttempts));
  setIf(hasArg('--final-settle'), 'finalSettle', num(options.finalSettle));
  setIf(hasArg('--resource-settle'), 'resourceSettle', num(options.resourceSettle));
  setIf(hasArg('--threshold'), 'threshold', floatNum(options.threshold));
  setIf(hasArg('--max-diff-pixels'), 'maxDiffPixels', num(options.maxDiffPixels));

  // Boolean flags
  const bool = (v: unknown) => Boolean(v);
  setIf(hasArg('--quiet'), 'quiet', bool(options.quiet));
  setIf(hasArg('--debug'), 'debug', bool(options.debug));
  setIf(hasArg('--print-urls'), 'printUrls', bool(options.printUrls));
  setIf(hasArg('--hide-time-estimates'), 'hideTimeEstimates', bool(options.hideTimeEstimates));
  setIf(hasArg('--hide-spinners'), 'hideSpinners', bool(options.hideSpinners));
  setIf(hasArg('--not-found-check'), 'notFoundCheck', bool(options.notFoundCheck));
  setIf(hasArg('--missing-only'), 'missingOnly', bool(options.missingOnly));
  setIf(hasArg('--full-page'), 'fullPage', bool(options.fullPage));

  // Array options
  const parseList = (s?: string) =>
    s
      ? s
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : undefined;
  setIf(hasArg('--include'), 'include', parseList(options.include));
  setIf(hasArg('--exclude'), 'exclude', parseList(options.exclude));

  const defaultConfigPath = getDefaultConfigPath(cwd);
  if (didUpdate && options.saveConfig) {
    saveUserConfig(cwd, updatedUserConfig as VisualRegressionConfig);
  } else if (!existsSync(defaultConfigPath) && options.saveConfig) {
    // No config file exists and no explicit overrides were provided: seed a config.json
    const seed: Record<string, unknown> = {};
    // Populate with discovered/detected reasonable defaults
    seed.url = options.url ?? 'http://localhost';
    seed.command = options.command;
    seed.workers = options.workers ? parseInt(options.workers, 10) : undefined;
    seed.retries = options.retries ? parseInt(options.retries, 10) : undefined;
    seed.maxFailures = options.maxFailures ? parseInt(options.maxFailures, 10) : undefined;
    seed.output = options.output ?? 'visual-regression';
    seed.browser = options.browser;
    seed.timezone = options.timezone;
    seed.locale = options.locale;
    seed.navTimeout = options.navTimeout ? parseInt(options.navTimeout, 10) : undefined;
    seed.waitTimeout = options.waitTimeout ? parseInt(options.waitTimeout, 10) : undefined;
    seed.overlayTimeout = options.overlayTimeout ? parseInt(options.overlayTimeout, 10) : undefined;
    seed.webserverTimeout = options.webserverTimeout
      ? parseInt(options.webserverTimeout, 10)
      : undefined;
    seed.stabilizeInterval = options.stabilizeInterval
      ? parseInt(options.stabilizeInterval, 10)
      : undefined;
    seed.stabilizeAttempts = options.stabilizeAttempts
      ? parseInt(options.stabilizeAttempts, 10)
      : undefined;
    seed.finalSettle = options.finalSettle ? parseInt(options.finalSettle, 10) : undefined;
    seed.resourceSettle = options.resourceSettle ? parseInt(options.resourceSettle, 10) : undefined;
    seed.waitUntil = options.waitUntil;
    seed.threshold = options.threshold ? parseFloat(options.threshold) : undefined;
    seed.maxDiffPixels = options.maxDiffPixels ? parseInt(options.maxDiffPixels, 10) : undefined;
    seed.fullPage = typeof options.fullPage === 'boolean' ? options.fullPage : undefined;
    seed.include = options.include
      ? options.include
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    seed.exclude = options.exclude
      ? options.exclude
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    // Remove undefineds before saving
    const cleaned = Object.fromEntries(Object.entries(seed).filter(([, v]) => v !== undefined));
    saveUserConfig(cwd, cleaned as VisualRegressionConfig);
  }

  const defaultConfig = createDefaultConfig();
  const detector = new StorybookConfigDetector(cwd);

  // Detect Storybook configuration from the project
  const detectedConfig = await detector.detectAndMergeConfig(defaultConfig);

  // Only drop auto-detected command if neither CLI nor user config specify it
  if (!options.command && !userConfig.command) {
    detectedConfig.storybookCommand = undefined;
  }

  // Construct proper URL with port
  // 1) Use --url if provided (with or without port)
  // 2) Fallback to detectedConfig.storybookPort
  const urlFromOptions: string | undefined = options.url ?? userConfig.url;
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

  const port = inferredPortFromUrl ?? userConfig.port ?? 9009;

  const baseUrl = urlFromOptions || 'http://localhost';
  const storybookUrl = (() => {
    // If url explicitly specifies a port, keep it as-is. Else append inferred/selected port.
    if (inferredPortFromUrl) return baseUrl;
    return baseUrl.includes(`:${port}`) ? baseUrl : `${baseUrl.replace(/\/$/, '')}:${port}`;
  })();

  // Docker environment detection and URL adjustment
  const isDockerEnvironment = Boolean(
    process.env.DOCKER_CONTAINER || process.env.CONTAINER || existsSync('/.dockerenv'),
  );

  // If running in Docker and using localhost/127.0.0.1, suggest host.docker.internal
  if (isDockerEnvironment && storybookUrl.includes('127.0.0.1')) {
    console.log(
      chalk.yellow(
        '⚠️  Docker detected: Consider using --url http://host.docker.internal:9009 instead of 127.0.0.1',
      ),
    );
  }

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

  const outputOpt = options.output ?? userConfig.output;
  const outputRoot = outputOpt
    ? path.isAbsolute(outputOpt)
      ? outputOpt
      : join(cwd, outputOpt)
    : join(cwd, 'visual-regression');
  const snapshotsDir = join(outputRoot, 'snapshots');
  const resultsDir = join(outputRoot, 'results');

  for (const dir of [outputRoot, snapshotsDir, resultsDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Parse threshold and maxDiffPixels options
  const thresholdOpt = options.threshold ? parseFloat(options.threshold) : undefined;
  const maxDiffPixelsOpt = parseNumberOption(options.maxDiffPixels);
  const fullPageOpt = typeof userConfig.fullPage === 'boolean' ? userConfig.fullPage : undefined;

  return {
    ...detectedConfig,
    storybookUrl,
    storybookCommand: options.command ?? userConfig.command ?? detectedConfig.storybookCommand,
    workers: workersOpt ?? detectedConfig.workers,
    retries: retriesOpt ?? detectedConfig.retries,
    timeout: detectedConfig.timeout,
    serverTimeout: serverTimeoutOpt ?? detectedConfig.serverTimeout,
    maxFailures: maxFailuresOpt ?? detectedConfig.maxFailures,
    headless: detectedConfig.headless,
    timezone: options.timezone || detectedConfig.timezone,
    locale: options.locale || detectedConfig.locale,
    browser,
    threshold: thresholdOpt ?? detectedConfig.threshold,
    maxDiffPixels: maxDiffPixelsOpt ?? detectedConfig.maxDiffPixels,
    fullPage:
      typeof options.fullPage === 'boolean'
        ? options.fullPage
        : (fullPageOpt ?? detectedConfig.fullPage),
    snapshotPath: snapshotsDir,
    resultsPath: resultsDir,
  };
}

// Helper function to wait for Storybook server to be ready
async function _waitForStorybookServer(url: string, timeout: number): Promise<void> {
  const startTime = Date.now();
  const maxWaitTime = timeout;

  console.log(`Waiting for Storybook server to be ready at ${replaceDockerHostInUrl(url)}...`);

  // Give Storybook some time to start up before we start polling
  console.log('Giving Storybook 5 seconds to start up...');
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Wait 3 seconds before hiding the log
  console.log('Waiting 3 seconds before hiding log output...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  let attempt = 1;
  while (Date.now() - startTime < maxWaitTime) {
    try {
      console.log(`🔍 Checking if Storybook is ready (attempt ${attempt})...`);

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
          console.log(`✓ Storybook server is ready at ${replaceDockerHostInUrl(url)}`);
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

// Removed duplicate program metadata registration to avoid conflicting --version option

// Init command - create default config file
// init command removed

// Shared runner used by multiple commands
async function runTests(options: CliOptions): Promise<void> {
  const _startedAt = Date.now();

  try {
    // Always use Playwright reporter path for proper webServer handling
    await runWithPlaywrightReporter(options);
  } catch (unknownError: unknown) {
    console.log(chalk.red('Test execution failed'));
    console.error(
      chalk.red(unknownError instanceof Error ? unknownError.message : 'Unknown error'),
    );
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

  // Load user config for CLI-specific options (without logging to avoid duplication)
  const userConfig = await loadUserConfig(originalCwd, options.config, true);

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

  const includePatterns = parsePatterns(
    options.include ?? (userConfig.include ? userConfig.include.join(',') : undefined),
  );
  const excludePatterns = parsePatterns(
    options.exclude ?? (userConfig.exclude ? userConfig.exclude.join(',') : undefined),
  );
  const grepPattern = (options.grep ?? userConfig.grep)?.trim() || undefined;
  const navTimeout = parseNumber(options.navTimeout, userConfig.navTimeout ?? 10_000);
  const waitTimeout = parseNumber(options.waitTimeout, userConfig.waitTimeout ?? 30_000);
  const overlayTimeout = parseNumber(options.overlayTimeout, userConfig.overlayTimeout ?? 5_000);
  const stabilizeInterval = parseNumber(
    options.stabilizeInterval,
    userConfig.stabilizeInterval ?? 0,
  );
  const stabilizeAttempts = parseNumber(
    options.stabilizeAttempts,
    userConfig.stabilizeAttempts ?? 0,
  );
  const finalSettle = parseNumber(options.finalSettle, userConfig.finalSettle ?? 500);
  const resourceSettle = parseNumber(options.resourceSettle, userConfig.resourceSettle ?? 100);
  const waitUntilCandidates = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);
  const waitUntilInput = (options.waitUntil || userConfig.waitUntil || '').toLowerCase();
  const waitUntilValue = waitUntilCandidates.has(waitUntilInput)
    ? (waitUntilInput as 'load' | 'domcontentloaded' | 'networkidle' | 'commit')
    : 'load';
  const notFoundRetryDelay = parseNumber(
    options.notFoundRetryDelay,
    userConfig.notFoundRetryDelay ?? 200,
  );
  const debugEnabled = Boolean(options.debug ?? userConfig.debug);
  const updateSnapshots = Boolean(options.updateSnapshots);
  const hideTimeEstimates = Boolean(options.hideTimeEstimates ?? userConfig.hideTimeEstimates);
  const hideSpinners = Boolean(options.hideSpinners ?? userConfig.hideSpinners);
  const printUrls = Boolean(options.printUrls ?? userConfig.printUrls);
  const missingOnly = Boolean(options.missingOnly ?? userConfig.missingOnly);
  const clean = Boolean(options.clean);
  const notFoundCheck = Boolean(options.notFoundCheck ?? userConfig.notFoundCheck);
  const isCIEnvironment = !process.stdout.isTTY;
  // Override CI detection for Docker environments - we want rich terminal output in Docker
  const isDockerEnvironment = Boolean(
    process.env.DOCKER_CONTAINER || process.env.CONTAINER || existsSync('/.dockerenv'),
  );
  const isStorybookMode = Boolean(options.storybook || process.env.STORYBOOK_MODE === 'true');
  const effectiveIsCI = isStorybookMode ? false : isCIEnvironment && !isDockerEnvironment;

  // Debug color environment in Storybook mode
  if (isStorybookMode) {
    console.log('[DEBUG] Storybook mode detected - Color environment:');
    console.log(`  FORCE_COLOR: ${process.env.FORCE_COLOR}`);
    console.log(`  TERM: ${process.env.TERM}`);
    console.log(`  COLORTERM: ${process.env.COLORTERM}`);
    console.log(`  NO_COLOR: ${process.env.NO_COLOR}`);
    console.log(`  CI: ${process.env.CI}`);
    console.log(`  process.stdout.isTTY: ${process.stdout.isTTY}`);
    console.log(`  effectiveIsCI: ${effectiveIsCI}`);

    // Test chalk color output
    const chalk = (await import('chalk')).default;
    console.log('[DEBUG] Chalk color test:');
    console.log(
      `  ${chalk.red('RED')} ${chalk.green('GREEN')} ${chalk.blue('BLUE')} ${chalk.yellow('YELLOW')}`,
    );
    console.log(
      `  ${chalk.cyan('CYAN')} ${chalk.magenta('MAGENTA')} ${chalk.bold('BOLD')} ${chalk.dim('DIM')}`,
    );
  }

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
    const hasPortFlagInCommand = /(\\s|^)(-p|--port)(\\s|=)/.test(baseCommand);
    // Only append --port when the user explicitly provided -p/--port on the CLI
    const userSpecifiedPortFlag = (() => {
      const argvJoined = process.argv.slice(2).join(' ');
      return /(\\s|^)(-p|--port)(\\s|=)/.test(argvJoined);
    })();

    const extraArgs: string[] = [];
    if (!hasPortFlagInCommand && userSpecifiedPortFlag && Number.isFinite(targetPort)) {
      extraArgs.push('--port', String(targetPort));
    }

    if (extraArgs.length === 0) return baseCommand;

    // If using npm/yarn/pnpm run, inject separator " -- " before args (unless already present)
    const isRunnerScript = /\b(npm|pnpm|yarn)\b.*\brun\b/.test(baseCommand);
    const hasSeparator = /\\s--\\s/.test(baseCommand);

    if (isRunnerScript && !hasSeparator) {
      return `${baseCommand} -- ${extraArgs.join(' ')}`;
    }
    // Otherwise append with a space
    return `${baseCommand} ${extraArgs.join(' ')}`;
  }

  // Extract port from storybookUrl for command building
  const storybookPort = (() => {
    try {
      const parsed = new URL(config.storybookUrl);
      return parsed.port ? parseInt(parsed.port) : 9009;
    } catch {
      const match = config.storybookUrl.match(/:(\d{2,5})(?:\/?|$)/);
      return match ? parseInt(match[1]) : 9009;
    }
  })();

  const storybookLaunchCommand = storybookCommand
    ? buildStorybookLaunchCommand(storybookCommand, storybookPort)
    : undefined;
  let finalStorybookCommand = storybookLaunchCommand;

  // Check if Storybook is already running if we have a command
  // Skip this check when using --storybook flag since Storybook is already running
  if (storybookLaunchCommand && !options.storybook) {
    const storybookIndexUrl = `${config.storybookUrl.replace(/\/$/, '')}/index.json`;
    console.log(
      `🔍 Checking if Storybook is already running at: ${replaceDockerHostInUrl(storybookIndexUrl)}`,
    );

    try {
      const response = await fetch(storybookIndexUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (response.ok) {
        console.log(`👍 Storybook is already running, skipping webserver startup`);
        finalStorybookCommand = undefined;
      } else {
        console.log(`🔍 Storybook not accessible (${response.status}), will start webserver`);
      }
    } catch (error) {
      console.log(
        `🔍 Storybook not accessible (${error instanceof Error ? error.message : 'unknown error'}), will start webserver`,
      );
    }
  } else if (options.storybook) {
    // When using --storybook flag, assume Storybook is already running
    console.log(`📚 Running in Storybook mode`);
    finalStorybookCommand = undefined;
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
    isCI: effectiveIsCI,
    isDocker: isDockerEnvironment,
    testTimeout,
    fullPage: runtimeConfig.fullPage,
    storybookMode: isStorybookMode,
  };

  const runtimeOptionsPath = join(projectRoot, 'dist', 'runtime-options.json');
  mkdirSync(path.dirname(runtimeOptionsPath), { recursive: true });
  writeFileSync(runtimeOptionsPath, JSON.stringify(runtimeOptions, null, 2), 'utf8');

  console.log('');
  console.log(chalk.bold('🚀 Starting Playwright visual regression tests...'));
  if (isDockerEnvironment) {
    console.log(`${chalk.dim('  •')} Running in Docker environment`);
  }
  if (storybookCommand && !options.storybook) {
    console.log(
      `${chalk.dim('  •')} Storybook command: ${chalk.cyan(storybookLaunchCommand)} (${chalk.dim(
        storybookCommand,
      )})`,
    );
    console.log(`${chalk.dim('  •')} Working directory: ${chalk.cyan(originalCwd)}`);
    if (isDockerEnvironment) {
      console.log(`${chalk.dim('  •')} Docker mode: Extended timeout (5min), output ignored`);
    }
    console.log(`${chalk.dim('  •')} Waiting for Storybook output...`);
  } else if (!options.storybook) {
    console.log(
      `${chalk.dim('  •')} Using existing Storybook server at ${chalk.cyan(replaceDockerHostInUrl(config.storybookUrl))}`,
    );
    console.log(`${chalk.dim('  •')} Working directory: ${chalk.cyan(originalCwd)}`);
  }

  if (!options.storybook) {
    console.log('');
  }

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
    } else if ((options as CliOptions).storybook) {
      // Use filtered reporter for Storybook mode - provides rich terminal output
      const filteredReporterCandidates = [
        join(projectRoot, 'dist', 'reporters', 'filtered-reporter.js'),
        join(projectRoot, 'src', 'reporters', 'filtered-reporter.ts'),
      ];
      const resolvedFilteredReporter = filteredReporterCandidates.find((p) => existsSync(p));
      reporterArg = resolvedFilteredReporter;
    } else if ((options as CliOptions).reporter || userConfig.reporter) {
      reporterArg = String((options as CliOptions).reporter ?? userConfig.reporter);
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
      env: {
        ...process.env,
        // Suppress npm warnings
        npm_config_loglevel: 'error',
        npm_config_silent: 'true',
        npm_config_progress: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    });

    // stdio inherited; no manual piping required

    await child;

    console.log('');
    if (options.updateSnapshots) {
      console.log(chalk.green('🎉 Visual regression tests updated successfully'));
    } else {
      console.log(chalk.green('🎉 Visual regression tests completed successfully'));
    }

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
  } catch (unknownError: unknown) {
    console.log('');
    console.log('');
    // Only show error message if it's not an aborted execution
    // Exit code 130 typically indicates SIGINT (Ctrl+C) - user interruption
    const exitCode = (unknownError as { exitCode?: number })?.exitCode;
    const errorMessage =
      unknownError instanceof Error ? unknownError.message : String(unknownError);

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
        console.error(chalk.gray(`Debug - Error object:`), unknownError);
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
        console.log(chalk.green('✓ Tests completed'));
      } else {
        console.error(chalk.red.bold('💥 Test execution failed'));
      }
    }

    console.log('');
    // Only exit with error code for critical failures, not warnings
    if (isNonCriticalError) {
      process.exit(0); // Success
    } else {
      process.exit(exitCode || 1); // Error
    }
  }
}

program.parse();
