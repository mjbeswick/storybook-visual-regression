import fs from 'node:fs';
import { JsonRpcServer } from '../jsonrpc.js';
import { logger } from '../logger.js';
import { type CliFlags } from '../config.js';
import { resolveConfig } from '../config.js';
import { setGlobalLogger } from '../logger.js';
import { run } from '../core/VisualRegressionRunner.js';
import { ResultsIndexManager } from '../core/ResultsIndex.js';
import { CLI_EVENTS, CLI_METHODS } from '../jsonrpc.js';

/**
 * Run the CLI in JSON-RPC mode for addon integration
 * This handles bidirectional communication with the Storybook addon
 */
export async function runJsonRpcMode(flags: CliFlags): Promise<number> {
  const config = resolveConfig(flags);
  setGlobalLogger(config.logLevel);
  const server = new JsonRpcServer();

  // Current run state
  let currentRun: { cancel: () => void } | null = null;
  let isRunning = false;

  // Send ready notification
  server.notify(CLI_EVENTS.READY, { version: '1.0.0' });

  // Register method handlers
  server.on(CLI_METHODS.RUN, async (params) => {
    if (isRunning) {
      throw new Error('A test run is already in progress');
    }

    isRunning = true;
    server.notify(CLI_EVENTS.PROGRESS, { running: true, completed: 0, total: 0 });

    try {
      // Merge provided params with base config
      const runConfig = { ...config };

      // Override config with params
      if (params) {
        Object.assign(runConfig, params);
      }

      // Create a promise that can be cancelled
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
      };

      currentRun = { cancel };

      // Set up progress callbacks
      const progressCallback = (progress: Record<string, unknown>) => {
        server.notify(CLI_EVENTS.PROGRESS, progress);
      };

      const storyStartCallback = (storyId: string, storyName: string) => {
        server.notify(CLI_EVENTS.STORY_START, { storyId, storyName });
      };

      const storyCompleteCallback = (result: Record<string, unknown>) => {
        server.notify(CLI_EVENTS.STORY_COMPLETE, result);
      };

      const resultCallback = (result: Record<string, unknown>) => {
        server.notify(CLI_EVENTS.RESULT, result);
      };

      const logCallback = (message: string) => {
        server.notify(CLI_EVENTS.LOG, { message });
      };

      // Run the tests with callbacks
      const code = await run(runConfig, {
        onProgress: progressCallback,
        onStoryStart: storyStartCallback,
        onStoryComplete: storyCompleteCallback,
        onResult: resultCallback,
        onLog: logCallback,
        cancelled: () => cancelled,
      });

      server.notify(CLI_EVENTS.COMPLETE, { code, cancelled });
      return { code, cancelled };
    } catch (error) {
      server.notify(CLI_EVENTS.ERROR, {
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      isRunning = false;
      currentRun = null;
      server.notify(CLI_EVENTS.PROGRESS, { running: false });
    }
  });

  server.on(CLI_METHODS.CANCEL, async () => {
    if (currentRun) {
      currentRun.cancel();
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  server.on(CLI_METHODS.SET_CONFIG, async (newConfig) => {
    // Update config (this would merge with existing config)
    Object.assign(config, newConfig);
    return { updated: true };
  });

  server.on(CLI_METHODS.GET_CONFIG, async () => {
    return config;
  });

  server.on(CLI_METHODS.GET_STATUS, async () => {
    return {
      isRunning,
      currentRun: currentRun ? true : false,
    };
  });

  server.on(CLI_METHODS.GET_RESULTS, async () => {
    // Read failed results from the results index
    try {
      const resultsDir = config.resolvePath(config.resultsPath);
      const resultsIndexManager = new ResultsIndexManager(resultsDir);
      const allEntries = resultsIndexManager.getAllEntries();

      // Filter to only failed results and convert to StoryResult format
      const failedResults = allEntries
        .filter((entry) => entry.status === 'failed')
        .map((entry) => {
          // Build paths for diff/actual images using getResultPath
          const diffPath = resultsIndexManager.getResultPath(
            entry.snapshotId,
            resultsDir,
            'diff',
            entry.storyId,
          );
          const actualPath = resultsIndexManager.getResultPath(
            entry.snapshotId,
            resultsDir,
            'actual',
            entry.storyId,
          );

          const diffExists = fs.existsSync(diffPath);
          const actualExists = fs.existsSync(actualPath);

          // Determine the actual failure reason based on available data
          let errorType:
            | 'screenshot_mismatch'
            | 'loading_failure'
            | 'network_error'
            | 'other_error'
            | undefined;
          let errorMessage: string | undefined;

          if (entry.status === 'failed') {
            // Check if we have diff comparison data (indicates screenshot was captured and compared)
            const hasComparisonData =
              entry.diffPixels !== undefined || entry.diffPercent !== undefined;

            if (hasComparisonData) {
              // Screenshot was captured and compared - this is a screenshot mismatch
              errorType = 'screenshot_mismatch';
              if (!diffExists) {
                // Diff file is missing even though comparison happened
                errorMessage = `Screenshot mismatch (${entry.diffPixels || 0} pixels, ${(entry.diffPercent || 0).toFixed(2)}%) - diff image missing`;
              } else {
                errorMessage = `Screenshot mismatch (${entry.diffPixels || 0} pixels, ${(entry.diffPercent || 0).toFixed(2)}%)`;
              }
            } else if (actualExists) {
              // Actual image exists but no comparison data - might be a comparison failure
              errorType = 'screenshot_mismatch';
              errorMessage = 'Screenshot mismatch (comparison data unavailable)';
            } else if (!entry.snapshotId) {
              // No snapshot ID means no baseline exists
              errorType = 'other_error';
              errorMessage = 'Missing baseline snapshot';
            } else {
              // No actual image and has snapshot ID - likely a loading failure
              errorType = 'loading_failure';
              errorMessage = 'Failed to capture screenshot';
            }

            // Log if diff is missing for debugging
            if (!diffExists && hasComparisonData) {
              logger.debug(
                `Missing diff image for ${entry.storyId}: expected at ${diffPath}, actual exists: ${actualExists}`,
              );
            }
          }

          return {
            storyId: entry.storyId,
            storyName: entry.storyId, // We don't have storyName in the index, use storyId
            status: entry.status as 'passed' | 'failed' | 'skipped' | 'timedOut',
            duration: entry.duration,
            diffPath: diffExists ? diffPath : undefined,
            actualPath: actualExists ? actualPath : undefined,
            expectedPath: undefined, // Expected path would be in snapshots, not results
            errorPath: entry.status === 'failed' && actualExists ? actualPath : undefined,
            errorType,
            error: errorMessage,
            diffPixels: entry.diffPixels,
            diffPercent: entry.diffPercent,
          };
        });

      return failedResults;
    } catch (error) {
      logger.error(`Failed to load results: ${error}`);
      return [];
    }
  });

  // Start the server
  server.start();

  // Keep the process alive
  return new Promise(() => {
    // Never resolve - process stays alive until killed
  });
}
