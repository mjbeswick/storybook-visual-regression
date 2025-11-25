import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { type RuntimeConfig } from '../config.js';
import { discoverStories } from './StorybookDiscovery.js';
import { detectViewports } from './StorybookConfigDetector.js';
import { writeRuntimeOptions, getRuntimeOptionsPath } from '../runtime/runtime-options.js';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { SnapshotIndexManager } from './SnapshotIndex.js';
import { ResultsIndexManager } from './ResultsIndex.js';
import { getCommandName } from '../utils/commandName.js';

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
  cleanEmptyDirectories(resultsPath);
};

export const cleanEmptyDirectories = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  const walk = (dir: string): void => {
    try {
      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          // Check again after walking subdirectories
          if (fs.existsSync(full) && fs.readdirSync(full).length === 0) {
            try {
              fs.rmSync(full, { recursive: true, force: true });
            } catch (e) {
              // Ignore errors (permissions, etc.)
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors
    }
  };

  walk(dirPath);
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

  const outputDir = config.resolvePath(config.outputDir);
  ensureDirs(config);

  // Initialize index managers - store index files in their respective directories
  const snapshotsDir = config.resolvePath(config.snapshotPath);
  const resultsDir = config.resolvePath(config.resultsPath);
  const indexManager = new SnapshotIndexManager(snapshotsDir);
  const resultsIndexManager = new ResultsIndexManager(resultsDir);

  // Set up signal handlers to flush index files on termination
  // These handlers run before the parallel runner's handlers to ensure indexes are saved
  const setupSignalHandlers = () => {
    let flushed = false;
    const flushIndexes = () => {
      if (flushed) return; // Only flush once
      flushed = true;
      logger.debug('Flushing index files before exit...');
      try {
        indexManager.flush();
        resultsIndexManager.flush();
      } catch (error) {
        logger.error(`Error flushing index files: ${error}`);
      }
    };

    // Handle SIGINT (Ctrl+C) and SIGTERM
    // Use 'on' instead of 'once' to ensure we catch the signal
    // Don't exit here - let the parallel runner handle that
    const sigintHandler = () => flushIndexes();
    const sigtermHandler = () => flushIndexes();

    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);

    // Also handle process exit as a fallback
    process.on('exit', () => {
      if (!flushed) {
        flushIndexes();
      }
    });

    // Return cleanup function to remove handlers if needed
    return () => {
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
    };
  };

  const removeSignalHandlers = setupSignalHandlers();

  // Discover stories
  logger.debug('Discovering stories from Storybook');
  const baseStories = await discoverStories(config);
  if (baseStories.length === 0) {
    logger.warn(
      'No stories discovered. Ensure Storybook is running and /index.json is accessible.',
    );
  }

  // Assign snapshot IDs to stories using index manager
  const browser = config.browser || 'chromium';
  const snapshotBasePath = config.resolvePath(config.snapshotPath);
  for (const story of baseStories) {
    const snapshotId = indexManager.getSnapshotId(story.id, browser, undefined, snapshotBasePath);
    story.snapshotId = snapshotId;
    // Keep snapshotRelPath for backward compatibility during migration
    if (!story.snapshotRelPath) {
      story.snapshotRelPath = indexManager.getSnapshotPath(
        snapshotId,
        config.snapshotPath,
        story.id,
      );
    }
  }

  // Clean up stale snapshots when updating
  if (config.update) {
    logger.debug('Cleaning stale snapshots and results during update mode');
    try {
      // Create a set of discovered storyIds for efficient lookup
      const discoveredStoryIds = new Set(baseStories.map((s) => s.id));

      // Clean up snapshots and entries for stories that no longer exist
      const snapshotCleanup = indexManager.cleanupStaleStories(
        discoveredStoryIds,
        config.resolvePath(config.snapshotPath),
      );
      if (snapshotCleanup.deletedSnapshots > 0 || snapshotCleanup.deletedEntries > 0) {
        logger.info(
          `Cleaned up ${snapshotCleanup.deletedSnapshots} snapshot file(s) and ${snapshotCleanup.deletedEntries} index entr${snapshotCleanup.deletedEntries === 1 ? 'y' : 'ies'} for removed stories`,
        );
      }

      // Clean up results and entries for stories that no longer exist
      const resultsCleanup = resultsIndexManager.cleanupStaleStories(
        discoveredStoryIds,
        config.resolvePath(config.resultsPath),
      );
      if (resultsCleanup.deletedResults > 0 || resultsCleanup.deletedEntries > 0) {
        logger.info(
          `Cleaned up ${resultsCleanup.deletedResults} result file(s) and ${resultsCleanup.deletedEntries} index entr${resultsCleanup.deletedEntries === 1 ? 'y' : 'ies'} for removed stories`,
        );
      }

      // Clean up duplicate entries (keep most recent, remove older duplicates)
      const duplicateSnapshotCleanup = indexManager.cleanupDuplicateEntries();
      if (duplicateSnapshotCleanup.deletedEntries > 0) {
        logger.info(
          `Cleaned up ${duplicateSnapshotCleanup.deletedEntries} duplicate snapshot entr${duplicateSnapshotCleanup.deletedEntries === 1 ? 'y' : 'ies'}`,
        );
      }

      const duplicateResultsCleanup = resultsIndexManager.cleanupDuplicateEntries();
      if (duplicateResultsCleanup.deletedEntries > 0) {
        logger.info(
          `Cleaned up ${duplicateResultsCleanup.deletedEntries} duplicate result entr${duplicateResultsCleanup.deletedEntries === 1 ? 'y' : 'ies'}`,
        );
      }

      // Clean up orphaned entries (entries without files)
      indexManager.cleanupOrphanedEntries(config.resolvePath(config.snapshotPath));
      resultsIndexManager.cleanupOrphanedEntries(config.resolvePath(config.resultsPath));

      // Clean up orphaned snapshot files (files without entries in index.json, hash dirs, chromium dirs)
      const orphanedSnapshotFilesCleanup = indexManager.cleanupOrphanedFiles(
        config.resolvePath(config.snapshotPath),
      );
      if (
        orphanedSnapshotFilesCleanup.deletedFiles > 0 ||
        orphanedSnapshotFilesCleanup.deletedDirectories > 0
      ) {
        logger.info(
          `Cleaned up ${orphanedSnapshotFilesCleanup.deletedFiles} orphaned snapshot file(s) and ${orphanedSnapshotFilesCleanup.deletedDirectories} director${orphanedSnapshotFilesCleanup.deletedDirectories === 1 ? 'y' : 'ies'}`,
        );
      }

      // Clean up orphaned result files (files without entries in index.json)
      const orphanedFilesCleanup = resultsIndexManager.cleanupOrphanedFiles(
        config.resolvePath(config.resultsPath),
      );
      if (orphanedFilesCleanup.deletedFiles > 0 || orphanedFilesCleanup.deletedDirectories > 0) {
        logger.info(
          `Cleaned up ${orphanedFilesCleanup.deletedFiles} orphaned result file(s) and ${orphanedFilesCleanup.deletedDirectories} empty director${orphanedFilesCleanup.deletedDirectories === 1 ? 'y' : 'ies'}`,
        );
      }

      // Clean up empty directories
      cleanEmptyDirectories(config.resolvePath(config.snapshotPath));
      cleanEmptyDirectories(config.resolvePath(config.resultsPath));
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
      const snapshotId = s.snapshotId!;
      const expected = indexManager.getSnapshotPath(snapshotId, snapshotRoot, s.id);
      if (!fs.existsSync(expected)) missing += 1;
    }
    if (missing > 0 && !config.update && !config.missingOnly) {
      const cmdName = getCommandName();
      logger.warn(
        `${missing} stor${missing === 1 ? 'y has' : 'ies have'} no baseline snapshot. ` +
          `Run '${cmdName} update --missing-only' to create missing baselines.`,
      );
    } else if (missing === 0) {
      logger.debug('All stories have baseline snapshots');
    }
  } catch (e) {
    logger.warn(`Failed to check for missing baselines: ${(e as Error).message}`);
  }

  // Filter to failed stories only if requested
  let storiesToTest = baseStories;
  if (config.failedOnly) {
    logger.debug('Filtering to failed stories only');
    const failedStoryIds = new Set<string>();
    const allResults = resultsIndexManager.getAllEntries();
    
    // Collect all story IDs that have failed results
    for (const result of allResults) {
      if (result.status === 'failed') {
        // Add the story ID (may have viewport suffix, so we'll match base IDs)
        failedStoryIds.add(result.storyId);
        // Also add base story ID without viewport suffix for matching
        const baseStoryId = result.storyId.replace(
          /--(unattended|attended|customer|mobile|tablet|desktop)$/,
          '',
        );
        if (baseStoryId !== result.storyId) {
          failedStoryIds.add(baseStoryId);
        }
      }
    }

    if (failedStoryIds.size === 0) {
      logger.warn('No failed stories found in results index');
      storiesToTest = [];
    } else {
      // Filter stories to only include those with failed results
      storiesToTest = baseStories.filter((story) => {
        // Check if story ID matches any failed story ID (exact or base match)
        const matches = failedStoryIds.has(story.id);
        if (matches) return true;
        
        // Also check base story ID (without viewport suffix)
        const baseStoryId = story.id.replace(
          /--(unattended|attended|customer|mobile|tablet|desktop)$/,
          '',
        );
        return failedStoryIds.has(baseStoryId);
      });

      const filteredCount = baseStories.length - storiesToTest.length;
      if (filteredCount > 0) {
        logger.info(
          `Filtered to ${storiesToTest.length} failed stor${storiesToTest.length === 1 ? 'y' : 'ies'} (removed ${filteredCount} passed/skipped)`,
        );
      }
    }
  }

  // Filter to missing snapshots only if requested (in update mode)
  if (config.missingOnly && config.update) {
    logger.debug('Filtering to stories with missing snapshots only');
    const snapshotRoot = config.resolvePath(config.snapshotPath);
    const storiesWithMissingSnapshots = storiesToTest.filter((story) => {
      const snapshotId = story.snapshotId!;
      const snapshotPath = indexManager.getSnapshotPath(snapshotId, snapshotRoot, story.id);
      const hasSnapshot = fs.existsSync(snapshotPath);
      return !hasSnapshot; // Only include stories without snapshots
    });

    const filteredCount = storiesToTest.length - storiesWithMissingSnapshots.length;
    if (filteredCount > 0) {
      logger.info(
        `Filtered to ${storiesWithMissingSnapshots.length} stor${storiesWithMissingSnapshots.length === 1 ? 'y' : 'ies'} with missing snapshots (skipped ${filteredCount} with existing snapshots)`,
      );
    } else if (storiesWithMissingSnapshots.length === 0) {
      logger.info('No stories with missing snapshots found');
    }

    storiesToTest = storiesWithMissingSnapshots;
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
  // Ensure snapshotRelPath is set for backward compatibility
  const storiesWithPaths = storiesToTest.map((s) => ({
    ...s,
    snapshotRelPath:
      s.snapshotRelPath ||
      (s.snapshotId ? indexManager.getSnapshotPath(s.snapshotId, config.snapshotPath, s.id) : ''),
  }));
  writeRuntimeOptions({ ...config, stories: storiesWithPaths }, runtimePath);
  logger.debug(`Runtime options written to: ${runtimePath}`);

  // Run tests directly in parallel using Promise.all like the example
  const originalCwd = process.cwd();

  logger.debug(`Working directory: ${originalCwd}`);
  logger.debug(`Runtime path: ${runtimePath}`);

  // Import and run the parallel test runner
  const { runParallelTests } = await import('../parallel-runner.js');
  const exitCode = await runParallelTests({
    stories: storiesToTest,
    config: {
      ...config,
      snapshotPath: path.resolve(originalCwd, config.snapshotPath),
      resultsPath: path.resolve(originalCwd, config.resultsPath),
    },
    runtimePath,
    debug: config.debug,
    callbacks,
    indexManager,
    resultsIndexManager,
  });

  // Remove signal handlers
  removeSignalHandlers();

  // Flush index updates
  indexManager.flush();
  resultsIndexManager.flush();

  // Clean up results directory to match index.json (always, not just in update mode)
  try {
    // Clean up orphaned entries (entries without files, including passed tests)
    resultsIndexManager.cleanupOrphanedEntries(config.resolvePath(config.resultsPath));

    // Clean up orphaned result files (files without entries in index.json)
    const orphanedFilesCleanup = resultsIndexManager.cleanupOrphanedFiles(
      config.resolvePath(config.resultsPath),
    );
    if (orphanedFilesCleanup.deletedFiles > 0 || orphanedFilesCleanup.deletedDirectories > 0) {
      logger.info(
        `Cleaned up ${orphanedFilesCleanup.deletedFiles} orphaned result file(s) and ${orphanedFilesCleanup.deletedDirectories} empty director${orphanedFilesCleanup.deletedDirectories === 1 ? 'y' : 'ies'}`,
      );
    }

    // Clean up empty directories
    cleanEmptyDirectories(config.resolvePath(config.resultsPath));
  } catch (e) {
    // Best-effort only, don't fail the run if cleanup has issues
    logger.debug(`Failed to clean results directory: ${(e as Error).message}`);
  }

  // Clean up empty directories after updates
  if (config.update) {
    try {
      cleanEmptyDirectories(config.resolvePath(config.snapshotPath));
      cleanEmptyDirectories(config.resolvePath(config.resultsPath));
    } catch (e) {
      logger.debug(`Failed to clean empty directories: ${(e as Error).message}`);
    }
  }

  logger.debug(`Test execution completed with exit code: ${exitCode}`);
  return exitCode;
};
