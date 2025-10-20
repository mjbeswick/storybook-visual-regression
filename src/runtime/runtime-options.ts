import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { VisualRegressionConfig } from '../types/index.js';

export type RuntimeOptions = {
  originalCwd: string;
  storybookUrl: string;
  outputDir: string;
  visualRegression: VisualRegressionConfig;
  include: string[];
  exclude: string[];
  grep?: string;
  navTimeout: number;
  waitTimeout: number;
  overlayTimeout: number;
  stabilizeInterval: number;
  stabilizeAttempts: number;
  finalSettle: number;
  resourceSettle: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  missingOnly: boolean;
  clean: boolean;
  notFoundCheck: boolean;
  notFoundRetryDelay: number;
  debug: boolean;
  updateSnapshots: boolean;
  hideTimeEstimates: boolean;
  hideSpinners: boolean;
  printUrls: boolean;
  isCI: boolean;
  testTimeout: number;
  fullPage?: boolean;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNTIME_OPTIONS_PATH = join(__dirname, '..', 'runtime-options.json');

let cachedOptions: RuntimeOptions | null = null;

export function tryLoadRuntimeOptions(): RuntimeOptions | null {
  if (cachedOptions) {
    return cachedOptions;
  }
  if (!existsSync(RUNTIME_OPTIONS_PATH)) {
    return null;
  }

  const raw = readFileSync(RUNTIME_OPTIONS_PATH, 'utf8');
  cachedOptions = JSON.parse(raw) as RuntimeOptions;
  return cachedOptions;
}

export function loadRuntimeOptions(): RuntimeOptions {
  const options = tryLoadRuntimeOptions();
  if (!options) {
    throw new Error(
      `Runtime options file not found at ${RUNTIME_OPTIONS_PATH}. Please run the CLI to generate it.`,
    );
  }
  return options;
}
