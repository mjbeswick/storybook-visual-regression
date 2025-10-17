import { existsSync } from 'fs';
import { join } from 'path';
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
export async function loadUserConfig(
  cwd: string,
  explicitPath?: string,
): Promise<UserConfig> {
  // If explicit path provided, use it
  if (explicitPath) {
    const resolvedPath = join(cwd, explicitPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
    return loadConfigFile(resolvedPath);
  }

  // Try to discover config file
  const discoveredPath = await discoverConfigFile(cwd);
  if (discoveredPath) {
    console.log(`📝 Using config file: ${discoveredPath}`);
    return loadConfigFile(discoveredPath);
  }

  // No config file found, return empty config
  return {};
}

