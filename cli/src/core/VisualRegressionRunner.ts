import fs from 'node:fs';
import path from 'node:path';
import { type RuntimeConfig } from '../config.js';
import { discoverStories } from './StorybookDiscovery.js';
import { detectViewports } from './StorybookConfigDetector.js';
import { writeRuntimeOptions, getRuntimeOptionsPath } from '../runtime/runtime-options.js';
import { fileURLToPath } from 'node:url';

export const ensureDirs = (config: RuntimeConfig): void => {
  fs.mkdirSync(config.resolvePath(config.snapshotPath), { recursive: true });
  fs.mkdirSync(config.resolvePath(config.resultsPath), { recursive: true });
};

export const cleanStaleArtifacts = (resultsPath: string): void => {
  if (!fs.existsSync(resultsPath)) return;
  // Best-effort cleanup: remove orphaned empty directories
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        if (fs.readdirSync(full).length === 0) fs.rmSync(full, { recursive: true, force: true });
      }
    }
  };
  walk(resultsPath);
};

export const run = async (config: RuntimeConfig): Promise<number> => {
  ensureDirs(config);
  cleanStaleArtifacts(config.resolvePath(config.resultsPath));

  // Discover stories
  const baseStories = await discoverStories(config);
  if (baseStories.length === 0) {
    process.stdout.write(
      'No stories discovered. Ensure Storybook is running and /index.json is accessible.\n',
    );
  }

  // Warn about missing baselines
  try {
    const snapshotRoot = config.resolvePath(config.snapshotPath);
    let missing = 0;
    for (const s of baseStories) {
      const expected = path.join(snapshotRoot, s.snapshotRelPath);
      if (!fs.existsSync(expected)) missing += 1;
    }
    if (missing > 0 && !config.update && !config.missingOnly) {
      process.stdout.write(
        `Warning: ${missing} stor${missing === 1 ? 'y has' : 'ies have'} no baseline snapshot. ` +
          `Run again with --update --missing-only to create only the missing baselines.\n`,
      );
    }
  } catch {
    // best-effort only
  }

  // Discover viewports if enabled
  const detected = await detectViewports(config);
  const effectiveViewports = detected.viewportSizes?.length
    ? detected.viewportSizes
    : config.viewportSizes;

  // Prepare runtime options for playwright spec consumption at a stable path inside this package
  const here = path.dirname(fileURLToPath(new URL(import.meta.url)));
  const packageRoot = path.resolve(here, '..'); // dist/
  const runtimePath = getRuntimeOptionsPath(packageRoot);
  writeRuntimeOptions({ ...config, stories: baseStories }, runtimePath);

  // Run tests directly in parallel using Promise.all like the example
  const originalCwd = process.cwd();

  // Debug logging
  if (config.debug) {
    process.stdout.write(`SVR Runner: Running ${baseStories.length} stories in parallel\n`);
    process.stdout.write(`SVR Runner: runtimePath=${runtimePath}\n`);
  }

  // Import and run the parallel test runner
  const { runParallelTests } = await import('../parallel-runner.js');
  const exitCode = await runParallelTests({
    stories: baseStories,
    config: {
      ...config,
      snapshotPath: path.resolve(originalCwd, config.snapshotPath),
      resultsPath: path.resolve(originalCwd, config.resultsPath),
    },
    runtimePath,
    debug: config.debug,
  });

  return exitCode;
};
