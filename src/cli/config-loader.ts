import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDefaultConfig } from '../config/defaultConfig.js';
import { pathToFileURL } from 'url';

export type UserConfig = {
  // Storybook configuration
  url?: string;
  port?: number;
  command?: string;

  // Test execution
  workers?: number;
  retries?: number;
  maxFailures?: number;
  output?: string;

  // Browser settings
  browser?: 'chromium' | 'firefox' | 'webkit';
  timezone?: string;
  locale?: string;

  // Timeouts (in milliseconds)
  navTimeout?: number;
  waitTimeout?: number;
  overlayTimeout?: number;
  webserverTimeout?: number;
  stabilizeInterval?: number;
  stabilizeAttempts?: number;
  finalSettle?: number;
  resourceSettle?: number;
  notFoundRetryDelay?: number;

  // Wait strategy
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

  // Filtering
  include?: string[];
  exclude?: string[];
  grep?: string;

  // Flags
  quiet?: boolean;
  debug?: boolean;
  printUrls?: boolean;
  hideTimeEstimates?: boolean;
  hideSpinners?: boolean;
  notFoundCheck?: boolean;
  missingOnly?: boolean;

  // Reporter
  reporter?: string;
  // Screenshot
  fullPage?: boolean;
};

/**
 * Discover config file in the current working directory
 * Looks for (in order):
 * 1. svr.config.js
 * 2. svr.config.ts
 * 3. svr.config.mjs
 * 4. .svrrc.json
 * 5. .svrrc
 */
export async function discoverConfigFile(cwd: string): Promise<string | null> {
  // Prefer the default JSON config inside visual-regression
  const preferred = join(cwd, 'visual-regression', 'config.json');
  if (existsSync(preferred)) return preferred;

  const candidates = [
    'svr.config.js',
    'svr.config.ts',
    'svr.config.mjs',
    'svr.config.cjs',
    '.svrrc.json',
    '.svrrc.js',
    '.svrrc',
  ];

  for (const candidate of candidates) {
    const path = join(cwd, candidate);
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Load config from a file path
 */
export async function loadConfigFile(configPath: string): Promise<UserConfig> {
  try {
    // Handle JSON files
    if (configPath.endsWith('.json') || configPath.endsWith('.svrrc')) {
      const { readFileSync } = await import('fs');
      const content = readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as UserConfig;
    }

    // Handle JS/TS files (ESM)
    const fileUrl = pathToFileURL(configPath).href;
    const module = await import(fileUrl);

    // Support both default export and named export
    const config = module.default || module.config || module;

    // If it's a function, call it
    if (typeof config === 'function') {
      return (await config()) as UserConfig;
    }

    return config as UserConfig;
  } catch (error) {
    throw new Error(
      `Failed to load config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Load user config from file or return empty config
 */
export async function loadUserConfig(cwd: string, explicitPath?: string): Promise<UserConfig> {
  // If explicit path provided, use it
  if (explicitPath) {
    const resolvedPath = join(cwd, explicitPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
    return loadConfigFile(resolvedPath);
  }

  // Try to discover config file; prefers visual-regression/config.json
  const discoveredPath = await discoverConfigFile(cwd);
  if (discoveredPath) {
    console.log(`📝 Using config file: ${discoveredPath}`);
    return loadConfigFile(discoveredPath);
  }

  // No config file found, return empty config
  return {};
}

export function getDefaultConfigPath(cwd: string): string {
  return join(cwd, 'visual-regression', 'config.json');
}

function computeUserDefaults(): Partial<UserConfig> {
  const d = createDefaultConfig();
  // Map tool defaults → user config keys
  const mapped: Partial<UserConfig> = {
    url: 'http://localhost:9009',
    command: d.storybookCommand,
    workers: d.workers,
    retries: d.retries,
    maxFailures: d.maxFailures,
    output: 'visual-regression',
    browser: d.browser,
    timezone: d.timezone,
    locale: d.locale,
    threshold: d.threshold,
    maxDiffPixels: d.maxDiffPixels,
    // Leave others undefined so they are not filtered unless explicitly known
  } as Partial<UserConfig & { threshold: number; maxDiffPixels?: number }>;
  return mapped;
}

function pruneDefaults(config: UserConfig): UserConfig {
  const defaults = computeUserDefaults();
  const prunedEntries = Object.entries(config)
    .filter(([, v]) => v !== undefined && v !== null)
    .filter(([k, v]) => {
      // Remove empty arrays
      if (Array.isArray(v) && v.length === 0) return false;
      // If we have a known default and it matches, drop it
      if (Object.prototype.hasOwnProperty.call(defaults, k)) {
        // @ts-expect-error index access
        const dv = defaults[k];
        return dv !== v;
      }
      return true;
    });
  return Object.fromEntries(prunedEntries) as UserConfig;
}

export function saveUserConfig(cwd: string, config: UserConfig): void {
  const toSave = pruneDefaults(config);
  const filePath = getDefaultConfigPath(cwd);
  const dir = join(cwd, 'visual-regression');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  const json = JSON.stringify(toSave, null, 2);
  
  // Only save if the content has actually changed
  let existingContent = '';
  if (existsSync(filePath)) {
    try {
      existingContent = readFileSync(filePath, 'utf8');
    } catch {
      // If we can't read the existing file, proceed with saving
      existingContent = '';
    }
  }
  
  if (json !== existingContent) {
    writeFileSync(filePath, json, 'utf8');
    console.log(`📝 Saved config: ${filePath}`);
  }
}
