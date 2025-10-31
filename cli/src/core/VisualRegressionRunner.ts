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

export const cleanStaleSnapshots = (
  snapshotPath: string,
  discoveredStories: Array<{ snapshotRelPath: string }>,
): void => {
  if (!fs.existsSync(snapshotPath)) return;

  // Collect all discovered snapshot paths (normalize to handle path separators)
  const discoveredPaths = new Set(
    discoveredStories.map((s) => path.normalize(s.snapshotRelPath)),
  );

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
  ensureDirs(config);
  cleanStaleArtifacts(config.resolvePath(config.resultsPath));

  // Discover stories
  const baseStories = await discoverStories(config);
  if (baseStories.length === 0) {
    process.stdout.write(
      'No stories discovered. Ensure Storybook is running and /index.json is accessible.\n',
    );
  }

  // Clean up stale snapshots when updating
  if (config.update) {
    try {
      cleanStaleSnapshots(config.resolvePath(config.snapshotPath), baseStories);
    } catch (e) {
      // Best-effort only, don't fail the run if cleanup has issues
      if (config.debug) {
        process.stdout.write(`Warning: Failed to clean stale snapshots: ${(e as Error).message}\n`);
      }
    }
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
    callbacks,
  });

  return exitCode;
};
