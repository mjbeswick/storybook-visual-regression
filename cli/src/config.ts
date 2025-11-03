import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, type VisualRegressionConfig } from './config/defaultConfig.js';

export type CliFlags = {
  config?: string;
  url?: string;
  output?: string;
  workers?: number;
  command?: string;
  webserverTimeout?: number;
  retries?: number;
  maxFailures?: number;
  timezone?: string;
  locale?: string;
  quiet?: boolean;
  debug?: boolean;
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  progress?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
  threshold?: number;
  maxDiffPixels?: number;
  fullPage?: boolean;
  overlayTimeout?: number;
  testTimeout?: number;
  snapshotRetries?: number;
  snapshotDelay?: number;
  mutationWait?: number;
  mutationTimeout?: number;
  grep?: string;
  include?: string;
  exclude?: string;
  installBrowsers?: string | boolean;
  installDeps?: boolean;
  notFoundCheck?: boolean;
  notFoundRetryDelay?: number;
  update?: boolean;
  missingOnly?: boolean;
  failedOnly?: boolean;
  saveConfig?: boolean;
  showProgress?: boolean;
  summary?: boolean;
  fixDate?: boolean | string | number;
  jsonRpc?: boolean;
};

export type RuntimeConfig = VisualRegressionConfig & {
  resolvePath: (p: string) => string;
  flags: CliFlags;
  command?: string;
  webserverTimeout?: number;
  quiet: boolean;
  debug: boolean;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  progress: boolean;
  installBrowsers?: string | boolean;
  installDeps?: boolean;
  notFoundCheck: boolean;
  notFoundRetryDelay: number;
  update: boolean;
  missingOnly: boolean;
  failedOnly: boolean;
  testTimeout?: number;
  overlayTimeout?: number;
  showProgress: boolean;
  summary: boolean;
  fixDate?: boolean | string | number;
  originalUrl?: string; // Store the original URL for display purposes
};

export const loadJsonFile = (maybePath?: string): Record<string, unknown> | undefined => {
  if (!maybePath) return undefined;
  const full = path.resolve(process.cwd(), maybePath);
  if (!fs.existsSync(full)) return undefined;
  const raw = fs.readFileSync(full, 'utf8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid JSON at ${full}: ${(err as Error).message}`);
  }
};

const normalizePatterns = (val?: string | string[]): string[] | undefined => {
  if (!val) return undefined;
  const list = Array.isArray(val) ? val : String(val).split(',');
  return list.map((s) => s.trim()).filter(Boolean);
};

// Detect if running in Docker
const isRunningInDocker = (): boolean => {
  return Boolean(
    process.env.DOCKER_CONTAINER === 'true' ||
      fs.existsSync('/.dockerenv') ||
      (process.env.HOSTNAME && process.env.HOSTNAME.includes('docker')),
  );
};

// Transform localhost to host.docker.internal when running in Docker
const transformDockerUrl = (url: string): string => {
  if (isRunningInDocker() && url.includes('localhost')) {
    return url.replace(/localhost/g, 'host.docker.internal');
  }
  return url;
};

export const resolveConfig = (flags: CliFlags): RuntimeConfig => {
  const base = defaultConfig();

  // If no config file specified, try common default locations
  let configPath = flags.config;
  if (!configPath) {
    if (fs.existsSync('config.json')) {
      configPath = 'config.json';
    } else {
      const vrConfig = path.join('visual-regression', 'config.json');
      if (fs.existsSync(vrConfig)) {
        configPath = vrConfig;
      }
    }
  }

  const fileConfigRaw = configPath ? loadJsonFile(configPath) : undefined;

  // Handle both old format (with visualRegression wrapper) and new format (direct properties)
  let fileVisual: Partial<VisualRegressionConfig>;
  if (fileConfigRaw) {
    if (fileConfigRaw.visualRegression && typeof fileConfigRaw.visualRegression === 'object') {
      // Old format: { visualRegression: { ... } }
      fileVisual = fileConfigRaw.visualRegression as Partial<VisualRegressionConfig>;
    } else {
      // New format: { ... } - treat the root object as visualRegression config
      fileVisual = fileConfigRaw as Partial<VisualRegressionConfig>;
    }
  } else {
    fileVisual = {};
  }

  // Get the original URL for display purposes
  const originalUrl = flags.url ?? fileVisual.url ?? base.url;

  const merged: VisualRegressionConfig = {
    ...base,
    ...fileVisual,
    url: transformDockerUrl(originalUrl),
    browser: (flags.browser ?? fileVisual.browser ?? base.browser) as RuntimeConfig['browser'],
    workers: flags.workers ?? fileVisual.workers ?? base.workers,
    threshold: flags.threshold ?? fileVisual.threshold ?? base.threshold,
    maxDiffPixels: flags.maxDiffPixels ?? fileVisual.maxDiffPixels ?? base.maxDiffPixels,
    fullPage: flags.fullPage ?? fileVisual.fullPage ?? base.fullPage,
    mutationWait: flags.mutationWait ?? fileVisual.mutationWait ?? base.mutationWait,
    mutationTimeout: flags.mutationTimeout ?? fileVisual.mutationTimeout ?? base.mutationTimeout,
    snapshotRetries: flags.snapshotRetries ?? fileVisual.snapshotRetries ?? base.snapshotRetries,
    snapshotDelay: flags.snapshotDelay ?? fileVisual.snapshotDelay ?? base.snapshotDelay,
    viewportSizes: fileVisual.viewportSizes ?? base.viewportSizes,
    defaultViewport: fileVisual.defaultViewport ?? base.defaultViewport,
    discoverViewports: fileVisual.discoverViewports ?? base.discoverViewports,
    includeStories: normalizePatterns(flags.include ?? fileVisual.includeStories),
    excludeStories: normalizePatterns(flags.exclude ?? fileVisual.excludeStories),
    grep: flags.grep ?? fileVisual.grep ?? base.grep,
    disableAnimations: fileVisual.disableAnimations ?? base.disableAnimations,
    fixDate: flags.fixDate ?? fileVisual.fixDate ?? base.fixDate ?? false,
    outputDir: flags.output ?? fileVisual.outputDir ?? base.outputDir,
    snapshotPath: ((): string => {
      const rootOut = flags.output ?? fileVisual.outputDir ?? base.outputDir;
      return path.join(rootOut, 'snapshots');
    })(),
    resultsPath: ((): string => {
      const rootOut = flags.output ?? fileVisual.outputDir ?? base.outputDir;
      return path.join(rootOut, 'results');
    })(),
    locale: fileVisual.locale ?? base.locale,
    timezone: fileVisual.timezone ?? base.timezone,
    frozenTime: fileVisual.frozenTime ?? base.frozenTime,
    masks: fileVisual.masks ?? base.masks,
    perStory: fileVisual.perStory ?? base.perStory,
    retries: flags.retries ?? fileVisual.retries ?? base.retries,
    maxFailures: flags.maxFailures ?? fileVisual.maxFailures ?? base.maxFailures,
  };

  const envLog = (process.env.SVR_LOG_LEVEL as RuntimeConfig['logLevel']) || undefined;
  const logLevel: RuntimeConfig['logLevel'] =
    flags.logLevel || envLog || (flags.debug ? 'debug' : 'info');

  const runtime: RuntimeConfig = {
    ...merged,
    resolvePath: (p: string) => path.resolve(process.cwd(), p),
    flags,
    command: flags.command,
    webserverTimeout: flags.webserverTimeout,
    quiet: Boolean(flags.quiet),
    debug: logLevel === 'debug' || Boolean(process.env.SVR_DEBUG || flags.debug),
    logLevel,
    progress: process.env.SVR_NO_PROGRESS ? false : (flags.progress ?? true),
    installBrowsers: flags.installBrowsers,
    installDeps: flags.installDeps,
    notFoundCheck: Boolean(flags.notFoundCheck),
    notFoundRetryDelay: flags.notFoundRetryDelay ?? 200,
    update: Boolean(flags.update),
    missingOnly: Boolean(flags.missingOnly),
    failedOnly: Boolean(flags.failedOnly),
    testTimeout: flags.testTimeout,
    overlayTimeout: flags.overlayTimeout,
    showProgress:
      flags.showProgress !== undefined
        ? Boolean(flags.showProgress)
        : (merged.showProgress ?? true),
    summary: flags.summary !== undefined ? Boolean(flags.summary) : (merged.summary ?? true),
    fixDate: merged.fixDate ?? false,
    originalUrl,
  };

  return runtime;
};

export const saveEffectiveConfig = (
  config: RuntimeConfig,
  flags: CliFlags,
  filePath: string,
): void => {
  const visualRegression: Record<string, any> = {};

  // Only include properties that were explicitly set via command line flags
  if (flags.url !== undefined) visualRegression.url = config.url;
  if (flags.output !== undefined) visualRegression.outputDir = config.outputDir;
  if (flags.browser !== undefined) visualRegression.browser = config.browser;
  if (flags.workers !== undefined) visualRegression.workers = config.workers;
  if (flags.retries !== undefined) visualRegression.retries = config.retries;
  if (flags.maxFailures !== undefined) visualRegression.maxFailures = config.maxFailures;
  if (flags.threshold !== undefined) visualRegression.threshold = config.threshold;
  if (flags.maxDiffPixels !== undefined) visualRegression.maxDiffPixels = config.maxDiffPixels;
  if (flags.fullPage !== undefined) visualRegression.fullPage = config.fullPage;
  if (flags.mutationWait !== undefined) visualRegression.mutationWait = config.mutationWait;
  if (flags.mutationTimeout !== undefined)
    visualRegression.mutationTimeout = config.mutationTimeout;
  if (flags.snapshotRetries !== undefined)
    visualRegression.snapshotRetries = config.snapshotRetries;
  if (flags.snapshotDelay !== undefined) visualRegression.snapshotDelay = config.snapshotDelay;
  if (flags.include !== undefined) visualRegression.includeStories = config.includeStories;
  if (flags.exclude !== undefined) visualRegression.excludeStories = config.excludeStories;
  if (flags.grep !== undefined) visualRegression.grep = config.grep;
  if (flags.fixDate !== undefined) visualRegression.fixDate = config.fixDate;
  if (flags.timezone !== undefined) visualRegression.timezone = config.timezone;
  if (flags.locale !== undefined) visualRegression.locale = config.locale;

  // These are typically set via config file, not CLI flags
  if (flags.config !== undefined) {
    // If a config file was specified, include other config properties that might be relevant
    visualRegression.viewportSizes = config.viewportSizes;
    visualRegression.defaultViewport = config.defaultViewport;
    visualRegression.discoverViewports = config.discoverViewports;
    visualRegression.disableAnimations = config.disableAnimations;
    visualRegression.frozenTime = config.frozenTime;
    visualRegression.masks = config.masks;
    visualRegression.perStory = config.perStory;
  }

  const data = visualRegression;
  const dest = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};
