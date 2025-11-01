import fs from 'node:fs';
import path from 'node:path';
import { type RuntimeConfig } from '../config.js';
import { discoverStories } from './StorybookDiscovery.js';
import { detectViewports } from './StorybookConfigDetector.js';
import { writeRuntimeOptions, getRuntimeOptionsPath } from '../runtime/runtime-options.js';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

export const ensureDirs = (config: RuntimeConfig): void => {
  logger.debug(
    `Ensuring directories exist: snapshots=${config.snapshotPath}, results=${config.resultsPath}`,
  );
  fs.mkdirSync(config.resolvePath(config.snapshotPath), { recursive: true });
  fs.mkdirSync(config.resolvePath(config.resultsPath), { recursive: true });
};

export const cleanStaleArtifacts = (resultsPath: string): void => {
  logger.debug(`Cleaning stale artifacts in: ${resultsPath}`);
  if (!fs.existsSync(resultsPath)) {
    logger.debug(`Results path does not exist, skipping cleanup: ${resultsPath}`);
    return;
  }
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

export const cleanStaleSnapshots = (
  snapshotPath: string,
  discoveredStories: Array<{ snapshotRelPath: string }>,
): void => {
  logger.debug(`Cleaning stale snapshots in: ${snapshotPath}`);
  if (!fs.existsSync(snapshotPath)) {
    logger.debug(`Snapshot path does not exist, skipping cleanup: ${snapshotPath}`);
    return;
  }

  // Collect all discovered snapshot paths (normalize to handle path separators)
  const discoveredPaths = new Set(discoveredStories.map((s) => path.normalize(s.snapshotRelPath)));

  // First pass: delete stale snapshot files
  const walkAndDelete = (dir: string, relDir: string = ''): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.join(relDir, name);
      const stat = fs.statSync(full);

      if (stat.isDirectory()) {
        walkAndDelete(full, rel);
      } else if (name.endsWith('.png')) {
        // Check if this snapshot file corresponds to any discovered story
        const normalized = path.normalize(rel);
        if (!discoveredPaths.has(normalized)) {
          // This snapshot doesn't correspond to any discovered story, delete it
          try {
            fs.unlinkSync(full);
          } catch (e) {
            // Ignore errors (file might already be deleted, permissions, etc.)
          }
        }
      }
    }
  };

  walkAndDelete(snapshotPath);

  // Second pass: clean up empty directories (similar to cleanStaleArtifacts)
  const cleanEmptyDirs = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        cleanEmptyDirs(full);
        if (fs.existsSync(full) && fs.readdirSync(full).length === 0) {
          try {
            fs.rmSync(full, { recursive: true, force: true });
          } catch (e) {
            // Ignore errors
          }
        }
      }
    }
  };

  cleanEmptyDirs(snapshotPath);
};

export interface RunCallbacks {
  onProgress?: (progress: any) => void;
  onStoryStart?: (storyId: string, storyName: string) => void;
  onStoryComplete?: (result: any) => void;
  onResult?: (result: any) => void;
  onLog?: (message: string) => void;
  cancelled?: () => boolean;
}

export const run = async (config: RuntimeConfig, callbacks?: RunCallbacks): Promise<number> => {
  logger.info('Starting visual regression test run');
  logger.debug(
    `Configuration: url=${config.url}, update=${config.update}, workers=${config.workers}, threshold=${config.threshold}`,
  );

  ensureDirs(config);
  cleanStaleArtifacts(config.resolvePath(config.resultsPath));

  // Discover stories
  logger.debug('Discovering stories from Storybook');
  const baseStories = await discoverStories(config);
  if (baseStories.length === 0) {
    logger.warn(
      'No stories discovered. Ensure Storybook is running and /index.json is accessible.',
    );
  } else {
    logger.info(`Discovered ${baseStories.length} stories`);
  }

  // Clean up stale snapshots when updating
  if (config.update) {
    logger.debug('Cleaning stale snapshots during update mode');
    try {
      cleanStaleSnapshots(config.resolvePath(config.snapshotPath), baseStories);
    } catch (e) {
      // Best-effort only, don't fail the run if cleanup has issues
      logger.warn(`Failed to clean stale snapshots: ${(e as Error).message}`);
    }
  }

  // Warn about missing baselines
  logger.debug('Checking for missing baseline snapshots');
  try {
    const snapshotRoot = config.resolvePath(config.snapshotPath);
    let missing = 0;
    for (const s of baseStories) {
      const expected = path.join(snapshotRoot, s.snapshotRelPath);
      if (!fs.existsSync(expected)) missing += 1;
    }
    if (missing > 0 && !config.update && !config.missingOnly) {
      logger.warn(
        `${missing} stor${missing === 1 ? 'y has' : 'ies have'} no baseline snapshot. ` +
          `Run with --update --missing-only to create missing baselines.`,
      );
    } else if (missing === 0) {
      logger.debug('All stories have baseline snapshots');
    }
  } catch (e) {
    logger.warn(`Failed to check for missing baselines: ${(e as Error).message}`);
  }

  // Discover viewports if enabled
  logger.debug('Detecting viewport configurations');
  const detected = await detectViewports(config);
  const effectiveViewports = detected.viewportSizes?.length
    ? detected.viewportSizes
    : config.viewportSizes;
  logger.debug(`Using ${effectiveViewports.length} viewport configurations`);

  // Prepare runtime options for playwright spec consumption at a stable path inside this package
  logger.debug('Preparing runtime options for test execution');
  const here = path.dirname(fileURLToPath(new URL(import.meta.url)));
  const packageRoot = path.resolve(here, '..'); // dist/
  const runtimePath = getRuntimeOptionsPath(packageRoot);
  writeRuntimeOptions({ ...config, stories: baseStories }, runtimePath);
  logger.debug(`Runtime options written to: ${runtimePath}`);

  // Run tests directly in parallel using Promise.all like the example
  const originalCwd = process.cwd();

  logger.info(`Starting test execution for ${baseStories.length} stories`);
  logger.debug(`Working directory: ${originalCwd}`);
  logger.debug(`Runtime path: ${runtimePath}`);

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
    callbacks,
  });

  logger.info(`Test execution completed with exit code: ${exitCode}`);
  return exitCode;
};
