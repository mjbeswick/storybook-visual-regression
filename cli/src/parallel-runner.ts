/*
 * High-performance parallel test runner optimized for thousands of URLs
 * Uses a worker pool with controlled concurrency to avoid overwhelming the system
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, Browser, Page } from 'playwright';
import ora from 'ora';
import { compare as odiffCompare } from 'odiff-bin';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import chalk from 'chalk';
import type { RuntimeConfig } from './config.js';
import type { DiscoveredStory } from './core/StorybookDiscovery.js';
import type { RunCallbacks } from './core/VisualRegressionRunner.js';
import { SnapshotIndexManager } from './core/SnapshotIndex.js';
import { ResultsIndexManager } from './core/ResultsIndex.js';
import { createLogger, setGlobalLogger } from './logger.js';
import { getCommandName } from './utils/commandName.js';

// Helper to parse fixDate config value into a Date object
function parseFixDate(value: boolean | string | number | undefined): Date {
  if (!value || value === true) {
    // Default: February 2, 2024, 10:00:00 UTC as requested
    return new Date('2024-02-02T10:00:00Z');
  }

  if (typeof value === 'number') {
    // If it's a number, assume it's already a timestamp
    if (value < 946684800000) {
      // Looks like seconds, convert to milliseconds
      return new Date(value * 1000);
    }
    return new Date(value);
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!isNaN(parsed)) {
      return new Date(parsed);
    }
    // Try as numeric string
    const numValue = Number(value);
    if (!isNaN(numValue)) {
      if (numValue < 946684800000) {
        return new Date(numValue * 1000);
      }
      return new Date(numValue);
    }
  }

  // Fallback to default
  return new Date('2024-02-02T10:00:00Z');
}

// Helper to remove empty directories recursively
function removeEmptyDirectories(dirPath: string, stopAt?: string): void {
  try {
    // Normalize paths for comparison (handle different path separators)
    const normalizedDirPath = path.normalize(dirPath);
    const normalizedStopAt = stopAt ? path.normalize(stopAt) : undefined;

    // Stop if we've reached the stopAt directory (e.g., resultsPath root)
    if (normalizedStopAt && normalizedDirPath === normalizedStopAt) {
      return;
    }

    // Check if directory exists and is empty
    if (fs.existsSync(normalizedDirPath)) {
      const files = fs.readdirSync(normalizedDirPath);
      if (files.length === 0) {
        // Directory is empty, remove it
        fs.rmdirSync(normalizedDirPath);
        // Recursively try to remove parent directory
        const parentDir = path.dirname(normalizedDirPath);
        if (parentDir !== normalizedDirPath) {
          // Only recurse if we haven't reached the root
          removeEmptyDirectories(parentDir, stopAt);
        }
      }
    }
  } catch (_error) {
    // Ignore errors (e.g., directory doesn't exist, permission issues)
    // This is cleanup code, so we don't want to throw
  }
}

// Helper to compare images in memory using pixelmatch
type InMemoryComparisonResult = {
  match: boolean;
  diffPixels: number;
  diffPercent: number;
  diffImage?: Buffer;
  reason?: string;
};

function compareImagesInMemory(
  actualBuffer: Buffer,
  expectedBuffer: Buffer,
  threshold: number,
): InMemoryComparisonResult {
  try {
    // Parse PNG images from buffers
    const actualImg = PNG.sync.read(actualBuffer) as PNG;
    const expectedImg = PNG.sync.read(expectedBuffer) as PNG;

    // Check dimensions match
    if (actualImg.width !== expectedImg.width || actualImg.height !== expectedImg.height) {
      return {
        match: false,
        diffPixels: 0,
        diffPercent: 0,
        reason: `Image dimensions differ: actual ${actualImg.width}×${actualImg.height}, expected ${expectedImg.width}×${expectedImg.height}`,
      };
    }

    // Check if buffers are identical (fast path)
    if (actualBuffer.equals(expectedBuffer)) {
      return {
        match: true,
        diffPixels: 0,
        diffPercent: 0,
      };
    }

    // Create diff image buffer
    const diffImg = new PNG({ width: actualImg.width, height: actualImg.height });

    // Compare images using pixelmatch
    // pixelmatch threshold is 0-1, where smaller values make comparison more sensitive
    // 0.1 = 10% difference per pixel (color difference) - this is quite lenient
    // We use a lower threshold (0.05 = 5%) to catch subtle differences
    // Our overall threshold (0-1) represents the percentage of pixels that can differ
    const pixelmatchThreshold = 0.05; // Per-pixel color difference threshold (5% - more sensitive)
    const diffPixels = pixelmatch(
      actualImg.data,
      expectedImg.data,
      diffImg.data,
      actualImg.width,
      actualImg.height,
      {
        threshold: pixelmatchThreshold,
        alpha: 0.1, // Ignore differences in alpha channel below 10%
        diffColor: [255, 0, 0], // Red for differences
        diffColorAlt: [0, 0, 255], // Blue for differences (alternate)
      },
    );

    // Calculate total pixels and difference percentage
    const totalPixels = actualImg.width * actualImg.height;
    const diffPercent = totalPixels > 0 ? (diffPixels / totalPixels) * 100 : 0;

    // Determine if images match based on threshold
    // threshold is interpreted as a percentage directly (not a fraction)
    // e.g., threshold=0.2 means 0.2% of pixels can differ
    // e.g., threshold=20 means 20% of pixels can differ
    // threshold=0 means no differences allowed (strict comparison)
    // diffPercent is already a percentage (0-100), so we compare directly
    const match = diffPixels === 0 || diffPercent <= threshold;

    // Encode diff image to buffer if there are differences
    let diffImageBuffer: Buffer | undefined;
    if (diffPixels > 0) {
      diffImageBuffer = PNG.sync.write(diffImg) as Buffer;
    }

    return {
      match,
      diffPixels,
      diffPercent,
      diffImage: diffImageBuffer,
      reason: match
        ? undefined
        : `${diffPixels} pixels differ (${diffPercent.toFixed(2)}% of image)`,
    };
  } catch (error) {
    return {
      match: false,
      diffPixels: 0,
      diffPercent: 0,
      reason: `Comparison failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Summary message helper
type SummaryParams = {
  passed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  created: number;
  updated: number;
  total: number;
  successPercent: number;
  verbose?: boolean;
  context: 'update' | 'test';
  testsPerMinute: string;
  duration?: string; // Duration in seconds (e.g., "150.5")
};

export function generateSummaryMessage({
  passed,
  failed,
  skipped,
  cancelled,
  created,
  updated,
  total,
  successPercent,
  verbose = false,
  context,
  testsPerMinute,
  duration,
}: SummaryParams): string {
  const lines: string[] = [];

  if (verbose) {
    const breakdown: string[] = [];
    if (context === 'update') {
      breakdown.push(`Created: ${created}`);
      breakdown.push(`Updated: ${updated}`);
      breakdown.push(`Failed: ${failed}`);
      if (cancelled > 0) {
        breakdown.push(`Cancelled: ${cancelled}`);
      }
      if (skipped > 0) {
        breakdown.push(`Skipped: ${skipped}`);
      }
      breakdown.push(`storiesPerMinute: ${testsPerMinute}`);
    } else {
      breakdown.push(`Passed: ${passed}`);
      breakdown.push(`Failed: ${failed}`);
      if (cancelled > 0) {
        breakdown.push(`Cancelled: ${cancelled}`);
      }
      if (skipped > 0) {
        breakdown.push(`Skipped: ${skipped}`);
      }
      breakdown.push(`Stories/m: ${testsPerMinute}`);
    }
    breakdown.push(`Total: ${total}`);
    if (duration) {
      const durationSeconds = parseFloat(duration);
      const minutes = Math.floor(durationSeconds / 60);
      const seconds = Math.floor(durationSeconds % 60);
      const durationStr =
        minutes > 0 ? `${minutes}m ${seconds}s` : `${durationSeconds.toFixed(1)}s`;
      breakdown.push(`Time: ${durationStr}`);
    }
    lines.push(breakdown.join(chalk.dim(' • ')));
    lines.push(chalk.cyan(`Success Rate: ${successPercent.toFixed(1)}%`));
  }

  return lines.join('\n');
}

type TestConfig = RuntimeConfig & {
  snapshotPath: string;
  resultsPath: string;
};

// Optimized worker pool for handling thousands of URLs
class WorkerPool {
  private queue: DiscoveredStory[] = [];
  private activeWorkers = 0;
  private maxWorkers: number;
  private results: {
    [storyId: string]: { success: boolean; error?: string; duration: number; action?: string };
  } = {};
  private cancelledStories = new Set<string>();
  private startTime = Date.now();
  private completed = 0;
  private total: number;
  private config: TestConfig;
  private onProgress?: (completed: number, total: number, results: any) => void;
  private onComplete?: (results: any) => void;
  private singleLineMode: boolean;
  private printUnderSpinner?: (line: string, keepStopped?: boolean) => void;
  private callbacks?: RunCallbacks;
  private log: ReturnType<typeof createLogger>;
  private maxFailuresReached = false;
  private cancelled = false;
  private initialBatchStarted = false;
  private storyViewports = new Map<string, { width: number; height: number } | undefined>();
  private cpuMonitorInterval?: NodeJS.Timeout;
  private lastCpuUsage: {
    user: number;
    nice: number;
    sys: number;
    idle: number;
    irq: number;
  } | null = null;
  private cpuUsageHistory: number[] = []; // Rolling window of CPU samples
  private readonly CPU_SAMPLE_WINDOW = 10; // Keep last 10 samples

  private indexManager: SnapshotIndexManager;
  private resultsIndexManager: ResultsIndexManager;

  constructor(
    maxWorkers: number,
    config: TestConfig,
    stories: DiscoveredStory[],
    printUnderSpinner?: (line: string) => void,
    callbacks?: RunCallbacks,
    indexManager?: SnapshotIndexManager,
    resultsIndexManager?: ResultsIndexManager,
  ) {
    this.maxWorkers = maxWorkers;
    this.config = config;
    if (!indexManager) {
      throw new Error('indexManager is required');
    }
    if (!resultsIndexManager) {
      throw new Error('resultsIndexManager is required');
    }
    this.indexManager = indexManager;
    this.resultsIndexManager = resultsIndexManager;
    this.total = stories.length;
    this.queue = [...stories];
    this.callbacks = callbacks;
    this.singleLineMode = Boolean(config.summary || config.showProgress);
    this.printUnderSpinner = printUnderSpinner;
    this.log = createLogger(config.logLevel);

    // Pre-calculate viewports for all stories
    this.preCalculateViewports();
  }

  getMaxWorkers(): number {
    return this.maxWorkers;
  }

  getCurrentCpuUsage(): number {
    if (this.cpuUsageHistory.length === 0) {
      return 0;
    }
    // Calculate rolling average
    const sum = this.cpuUsageHistory.reduce((a, b) => a + b, 0);
    return sum / this.cpuUsageHistory.length;
  }

  private calculateCpuUsage(): number {
    const cpus = os.cpus();
    if (cpus.length === 0) {
      return 0;
    }

    // Sum up all CPU times across all cores
    const totalCpu = cpus.reduce(
      (acc, cpu) => {
        const times = cpu.times;
        return {
          user: acc.user + times.user,
          nice: acc.nice + times.nice,
          sys: acc.sys + times.sys,
          idle: acc.idle + times.idle,
          irq: acc.irq + (times.irq || 0),
        };
      },
      { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    );

    if (this.lastCpuUsage) {
      // Calculate CPU usage based on time difference between samples
      const totalUsed =
        totalCpu.user +
        totalCpu.nice +
        totalCpu.sys +
        totalCpu.irq -
        (this.lastCpuUsage.user +
          this.lastCpuUsage.nice +
          this.lastCpuUsage.sys +
          this.lastCpuUsage.irq);
      const totalIdle = totalCpu.idle - this.lastCpuUsage.idle;
      const totalTime = totalUsed + totalIdle;

      if (totalTime > 0) {
        return Math.min((totalUsed / totalTime) * 100, 100);
      }
    }

    this.lastCpuUsage = totalCpu;
    return 0;
  }

  private sampleCpuUsage(): void {
    const cpuUsage = this.calculateCpuUsage();

    // Add to rolling window
    if (cpuUsage > 0 || this.cpuUsageHistory.length === 0) {
      this.cpuUsageHistory.push(cpuUsage);

      // Keep only last N samples
      if (this.cpuUsageHistory.length > this.CPU_SAMPLE_WINDOW) {
        this.cpuUsageHistory.shift();
      }
    }
  }

  private startCpuMonitoring(): void {
    // Sample CPU every 500ms for rolling average
    this.cpuMonitorInterval = setInterval(() => {
      if (this.completed < this.total && !this.maxFailuresReached && !this.cancelled) {
        this.sampleCpuUsage();
      }
    }, 500);
  }

  private stopCpuMonitoring(): void {
    if (this.cpuMonitorInterval) {
      clearInterval(this.cpuMonitorInterval);
      this.cpuMonitorInterval = undefined;
    }
  }

  private preCalculateViewports(): void {
    for (const story of this.queue) {
      let viewport: { width: number; height: number } | undefined;
      const viewportConfig = this.config.perStory?.[story.id]?.viewport;

      if (viewportConfig) {
        // Per-story override exists
        if (typeof viewportConfig === 'object') {
          viewport = viewportConfig;
        } else if (typeof viewportConfig === 'string') {
          // viewportConfig is a string name, look it up
          const viewportSize = this.config.viewportSizes.find((v) => v.name === viewportConfig);
          if (viewportSize) {
            viewport = { width: viewportSize.width, height: viewportSize.height };
          }
        }
      } else {
        // No per-story override, check if story defines its own viewport preference
        // Check both parameters.viewport.defaultViewport and globals.viewport.value
        const storyViewportName =
          story.parameters?.viewport?.defaultViewport || story.globals?.viewport?.value;
        if (storyViewportName) {
          const storyViewportSize = this.config.viewportSizes.find(
            (v) => v.name === storyViewportName,
          );
          if (storyViewportSize) {
            viewport = { width: storyViewportSize.width, height: storyViewportSize.height };
          }
          // If story has a viewport preference we don't recognize, leave viewport undefined
          // so Storybook can apply its own viewport settings
        }

        // Fall back to global default viewport only if story has no viewport preference at all
        if (!viewport && !storyViewportName) {
          const defaultViewportName = this.config.defaultViewport;
          const defaultViewportSize = this.config.viewportSizes.find(
            (v) => v.name === defaultViewportName,
          );
          if (defaultViewportSize) {
            viewport = { width: defaultViewportSize.width, height: defaultViewportSize.height };
          }
        }
      }

      this.storyViewports.set(story.id, viewport);
    }
  }

  getViewport(storyId: string): { width: number; height: number } | undefined {
    return this.storyViewports.get(storyId);
  }

  // Unified method for printing story results
  private printStoryResult(
    displayName: string,
    result: 'success' | 'skipped' | 'failed' | 'cancelled',
    duration: number,
    errorDetails?: { reason: string; url: string; diffPath?: string; expectedPath?: string },
    viewportName?: string,
  ): void {
    // Skip output if quiet mode
    if (this.config.quiet) {
      return;
    }

    // Helper to format duration with performance-based coloring
    const colorDuration = (durationMs: number): string => {
      const secs = durationMs / 1000;
      const secsStr = secs.toFixed(1);
      const unit = chalk.dim('s');
      const storyLoadTime = this.config.storyLoadDelay ?? 0;
      if (secs < storyLoadTime / 1000 + 2) {
        return chalk.green(secsStr + chalk.dim(unit));
      } else if (secs < storyLoadTime / 1000 + 4) {
        return chalk.yellow(secsStr + chalk.dim(unit));
      } else {
        return chalk.red(secsStr + chalk.dim(unit));
      }
    };

    // Build the result line
    let line: string;
    let logLevel: 'info' | 'error' = 'info';

    // Format viewport info - show viewport name if available
    const viewportInfo = viewportName ? chalk.dim(`(${viewportName})`) : '';

    switch (result) {
      case 'success':
        line = `${chalk.green('✓')} ${displayName} ${colorDuration(duration)} ${viewportInfo}`;
        break;
      case 'skipped':
        line = `${chalk.yellow('○')} ${displayName} ${colorDuration(duration)} ${chalk.dim('(no snapshot)')} ${viewportInfo}`;
        break;
      case 'failed':
        line = `${chalk.red('✗')} ${displayName} ${colorDuration(duration)} ${viewportInfo}`;
        logLevel = 'error';
        break;
      case 'cancelled':
        line = `${chalk.gray('○')} ${displayName} ${colorDuration(duration)} ${chalk.dim('(cancelled)')} ${viewportInfo}`;
        break;
    }

    // Print the main result line
    // For failures, stop the spinner and keep it stopped so error details are visible
    const isFailure = result === 'failed';
    if (this.printUnderSpinner) {
      this.printUnderSpinner(line, isFailure);
    } else {
      if (logLevel === 'error') {
        this.log.error(line);
      } else {
        this.log.info(line);
      }
    }

    // Print error details for failed tests
    if (result === 'failed' && errorDetails) {
      // Color the error reason based on type
      let coloredReason: string;
      const reason = errorDetails.reason;
      if (reason === 'Network error') {
        coloredReason = chalk.red(reason);
      } else if (reason === 'Operation timed out') {
        coloredReason = chalk.yellow(reason);
      } else if (reason === 'Failed to capture screenshot') {
        coloredReason = chalk.magenta(reason);
      } else if (reason === 'Visual differences detected') {
        coloredReason = chalk.blue('Visual regression failed');
      } else if (reason === 'No baseline snapshot found') {
        coloredReason = chalk.cyan(reason);
      } else {
        coloredReason = chalk.red(reason); // Default to red for unknown errors
      }

      const detailLines = [`  ${coloredReason}`];

      for (const detailLine of detailLines) {
        if (this.printUnderSpinner) {
          // Keep spinner stopped for all error detail lines except the last one
          // The last detail line will trigger spinner resume after a delay
          const isLastLine = detailLine === detailLines[detailLines.length - 1];
          this.printUnderSpinner(detailLine, !isLastLine);
        } else {
          this.log.error(detailLine);
        }
      }
    }
  }

  getResults() {
    return this.results;
  }

  private cleanupEmptyDirectories(): void {
    // Only cleanup in test mode (not update mode) since we delete matching screenshots
    if (this.config.update) {
      return;
    }

    try {
      // Clean up the results directory structure by walking it and removing empty directories
      // This is safer than trying to track individual story paths during parallel execution
      this.log.debug('Cleaning up empty directories in results path...');

      // Use a simple approach: walk the results directory and remove empty dirs
      const cleanupDir = (dirPath: string, stopAt: string): void => {
        try {
          if (!fs.existsSync(dirPath)) {
            return;
          }

          // Stop if we've reached the stopAt directory
          const normalizedDirPath = path.normalize(dirPath);
          const normalizedStopAt = path.normalize(stopAt);
          if (normalizedDirPath === normalizedStopAt) {
            return;
          }

          const files = fs.readdirSync(dirPath);
          if (files.length === 0) {
            // Directory is empty, remove it
            fs.rmdirSync(dirPath);
            this.log.debug(`Removed empty directory: ${dirPath}`);
            // Recursively try to remove parent directory
            const parentDir = path.dirname(dirPath);
            if (parentDir !== dirPath) {
              cleanupDir(parentDir, stopAt);
            }
          }
        } catch (error) {
          // Ignore errors (directory might have been removed by another process, etc.)
          this.log.debug(`Error cleaning directory ${dirPath}: ${error}`);
        }
      };

      // Start cleanup from resultsPath, checking each subdirectory
      if (fs.existsSync(this.config.resultsPath)) {
        const walkAndCleanup = (dirPath: string): void => {
          try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            // First, recursively clean up subdirectories
            for (const entry of entries) {
              if (entry.isDirectory()) {
                const subDir = path.join(dirPath, entry.name);
                walkAndCleanup(subDir);
              }
            }

            // Then check if this directory is empty (after subdirectories are cleaned)
            const remainingEntries = fs.readdirSync(dirPath);
            if (remainingEntries.length === 0 && dirPath !== this.config.resultsPath) {
              cleanupDir(dirPath, this.config.resultsPath);
            }
          } catch (error) {
            // Ignore errors
            this.log.debug(`Error walking directory ${dirPath}: ${error}`);
          }
        };

        walkAndCleanup(this.config.resultsPath);
      }
    } catch (error) {
      // Don't fail the test run if cleanup fails
      this.log.debug(`Directory cleanup failed: ${error}`);
    }
  }

  cancel() {
    this.cancelled = true;
    this.log.debug('Worker pool cancelled - marking remaining queued tests as cancelled');

    // Mark all remaining queued stories as cancelled
    while (this.queue.length > 0) {
      const story = this.queue.shift()!;
      this.handleCancelledStory(story, this.startTime);
    }
  }

  private handleCancelledStory(story: DiscoveredStory, startTime: number): void {
    const duration = Date.now() - startTime;

    // Normalize slashes to have consistent spacing
    const normalizeSlashes = (str: string): string => {
      return str.replace(/\s*\/\s*/g, ' / ');
    };

    const title = story.title ? normalizeSlashes(story.title) : '';
    const name = normalizeSlashes(story.name);
    const displayName = title ? `${title} / ${name}` : name;

    // Record cancelled result
    this.results[story.id] = {
      success: false, // Cancelled is not a success, but also not a failure
      duration,
      action: 'cancelled',
    };

    // Track cancelled stories
    this.cancelledStories.add(story.id);

    // Notify callbacks
    this.callbacks?.onResult?.({
      storyId: story.id,
      storyName: displayName,
      status: 'cancelled',
      duration,
      action: 'cancelled',
    });

    this.callbacks?.onStoryComplete?.({
      storyId: story.id,
      storyName: displayName,
      status: 'cancelled',
      duration,
      action: 'cancelled',
    });

    // Don't print individual cancelled stories to avoid cluttering output
    // The summary will show the total count of cancelled tests
    // this.printStoryResult(story, displayName, 'cancelled', duration);

    this.completed++;
    this.onProgress?.(this.completed, this.total, this.results);
  }

  async run(
    onProgress?: (completed: number, total: number, results: any) => void,
    onComplete?: (results: any) => void,
  ): Promise<{ success: boolean; failed: number }> {
    this.onProgress = onProgress;
    this.onComplete = onComplete;

    // Start CPU monitoring for status display
    this.startCpuMonitoring();

    return new Promise((resolve) => {
      // Start initial workers with staggered launches
      for (let i = 0; i < Math.min(this.maxWorkers, this.queue.length); i++) {
        this.spawnWorker(true);
      }

      // Check for completion periodically
      const checkComplete = () => {
        // If maxFailures is reached, exit immediately without waiting for active workers
        // Active workers will finish their current tests and stop at the next cancellation checkpoint
        if (this.maxFailuresReached) {
          this.stopCpuMonitoring();
          const failed = Object.values(this.results).filter(
            (r) => !r.success && r.action === 'failed',
          ).length;
          const success = failed === 0;

          // Clean up empty directories now that all tests are complete/stopped
          this.cleanupEmptyDirectories();

          this.onComplete?.(this.results);
          resolve({ success, failed });
          return;
        }

        // Check if cancelled and no workers are active
        if (this.cancelled && this.activeWorkers === 0) {
          this.stopCpuMonitoring();
          const failed = Object.values(this.results).filter(
            (r) => !r.success && r.action === 'failed',
          ).length;
          const success = failed === 0;

          // Clean up empty directories now that all tests are complete/stopped
          this.cleanupEmptyDirectories();

          this.onComplete?.(this.results);
          resolve({ success, failed });
          return;
        }

        if (this.completed >= this.total) {
          this.stopCpuMonitoring();
          const failed = Object.values(this.results).filter(
            (r) => !r.success && r.action === 'failed',
          ).length;
          const success = failed === 0;

          // Clean up empty directories now that all tests are complete
          // This is safe to do now since no workers are creating new files
          this.cleanupEmptyDirectories();

          this.onComplete?.(this.results);
          resolve({ success, failed });
        } else {
          setTimeout(checkComplete, 100); // Check every 100ms
        }
      };
      checkComplete();
    });
  }

  private spawnWorker(staggerLaunch = false) {
    // Continuously spawn workers until we reach capacity or run out of work
    // Stop spawning if maxFailures is reached or cancelled
    while (
      this.queue.length > 0 &&
      this.activeWorkers < this.maxWorkers &&
      !this.maxFailuresReached &&
      !this.cancelled
    ) {
      this.activeWorkers++;
      const story = this.queue.shift()!;

      this.runStoryTest(story, staggerLaunch).finally(() => {
        this.activeWorkers--;
        // After completion, check if we need to spawn more workers
        // Use setImmediate to avoid deep recursion
        // But only spawn if we haven't reached max failures or been cancelled
        if (!this.maxFailuresReached && !this.cancelled) {
          setImmediate(() => this.spawnWorker());
        }
      });
    }
  }

  private async runStoryTest(story: DiscoveredStory, staggerLaunch = false): Promise<void> {
    const startTime = Date.now();
    this.log.debug(`Starting test for story: ${story.id} (${story.title}/${story.name})`);

    // Check if cancelled or max failures reached before starting
    if (this.cancelled || this.maxFailuresReached) {
      this.log.debug(
        `Story ${story.id}: Test cancelled before execution (cancelled: ${this.cancelled}, maxFailuresReached: ${this.maxFailuresReached})`,
      );
      this.handleCancelledStory(story, startTime);
      return;
    }

    // Notify callbacks that story has started
    this.callbacks?.onStoryStart?.(story.id, `${story.title}/${story.name}`);

    // Compute a human-friendly display name using title/name from story ID, maintaining path structure
    const toDisplayName = (): string => {
      // Use title as the directory path and name as the basename
      // This is closer to the story ID structure (title--name) while keeping path splitting
      // Normalize slashes to have consistent spacing
      const normalizeSlashes = (str: string): string => {
        return str.replace(/\s*\/\s*/g, ' ' + chalk.dim('/') + ' ');
      };

      const title = story.title ? normalizeSlashes(story.title) : '';
      const name = normalizeSlashes(story.name);

      return title ? `${title} ${chalk.dim('/')} ${name}` : name;
    };
    // Get pre-calculated viewport for this story
    const storyViewport = this.getViewport(story.id);

    const displayName = toDisplayName();

    let lastError: Error | null = null;
    let result: string | null = null;
    let page: Page | undefined; // Store page reference for DOM dumping on timeout
    let displayViewport = storyViewport; // Will be updated with actual viewport if available
    let displayViewportName: string | undefined; // Will be updated with viewport name if available
    let comparisonResult: InMemoryComparisonResult | null = null; // Store comparison result for result tracking

    try {
      // Small staggered delay to stagger browser launches and reduce resource contention
      if (staggerLaunch) {
        // Use a simple hash of story ID to create consistent, staggered delays
        let hash = 0;
        for (let i = 0; i < story.id.length; i++) {
          hash = ((hash << 5) - hash + story.id.charCodeAt(i)) & 0xffffffff;
        }
        const delay = Math.abs(hash) % 150; // 0-150ms staggered delay based on story ID
        this.log.debug(
          `Story ${story.id}: Staggering browser launch (delay: ${delay.toFixed(1)}ms)`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // Check if max failures reached before starting test
      if (this.maxFailuresReached || this.cancelled) {
        this.log.debug(`Story ${story.id}: Test cancelled`);
        throw new Error('Test cancelled');
      }

      const attemptStart = Date.now();
      const testResult = await this.executeSingleTestAttempt(story, storyViewport);
      result = testResult.result;
      page = testResult.page; // Store page reference for potential DOM dump
      // Use actual viewport from page if available, otherwise fall back to configured viewport
      displayViewport = testResult.actualViewport || storyViewport;
      // Store viewport name for display
      displayViewportName = testResult.viewportName;
      // Store comparison result for result tracking
      comparisonResult = testResult.comparisonResult || null;
      const attemptDuration = Date.now() - attemptStart;
      this.log.debug(`Story ${story.id}: Test succeeded in ${attemptDuration}ms`);
    } catch (error) {
      lastError = error as Error;

      // Dump DOM if timeout or crash occurred
      const isTimeout =
        lastError && /timeout|Timed out|Operation timed out/i.test(String(lastError));
      const isCrash = lastError && /Target crashed|crashed|Protocol error/i.test(String(lastError));
      if ((isTimeout || isCrash) && page && !page.isClosed()) {
        try {
          await this.dumpPageStateOnTimeout(story, page);
        } catch (dumpError) {
          this.log.debug(
            `Story ${story.id}: Failed to dump DOM on ${isTimeout ? 'timeout' : 'crash'}:`,
            dumpError,
          );
        }
      }
    }

    const duration = Date.now() - startTime;
    this.log.debug(
      `Story ${story.id}: Test completed in ${duration}ms with result: ${result || 'failed'}`,
    );

    if (result !== null) {
      // Success
      this.results[story.id] = { success: true, duration, action: result };

      // Record result in results index (skip in update mode - we're updating baselines, not running tests)
      if (!this.config.update && story.snapshotId) {
        const status = result.includes('baseline') ? 'new' : 'passed';
        const browser = this.config.browser || 'chromium';
        this.resultsIndexManager.setResult(story.id, story.snapshotId, status, {
          browser,
          viewportName: displayViewportName,
          diffPixels: comparisonResult ? comparisonResult.diffPixels : 0,
          diffPercent: comparisonResult ? comparisonResult.diffPercent : 0,
          duration,
        });
      }

      // Notify callbacks of successful result
      this.callbacks?.onResult?.({
        storyId: story.id,
        storyName: displayName,
        status: 'passed',
        duration,
        action: 'passed',
      });

      this.callbacks?.onStoryComplete?.({
        storyId: story.id,
        storyName: displayName,
        status: 'passed',
        duration,
        action: 'passed',
      });

      // Print result using unified method
      this.printStoryResult(displayName, 'success', duration, undefined, displayViewportName);
    } else {
      // Check if this test was cancelled
      const isCancelled = lastError && String(lastError).includes('Test cancelled');

      if (isCancelled) {
        // Cancelled
        this.results[story.id] = {
          success: false, // Cancelled is not a success, but also not a failure for maxFailures counting
          duration,
          action: 'cancelled',
        };

        // Track cancelled stories
        this.cancelledStories.add(story.id);

        // Notify callbacks of cancelled result
        this.callbacks?.onResult?.({
          storyId: story.id,
          storyName: displayName,
          status: 'cancelled',
          duration,
          action: 'cancelled',
        });

        this.callbacks?.onStoryComplete?.({
          storyId: story.id,
          storyName: displayName,
          status: 'cancelled',
          duration,
          action: 'cancelled',
        });

        // Don't print individual cancelled stories to avoid cluttering output
        // The summary will show the total count of cancelled tests
        // this.printStoryResult(story, displayName, 'cancelled', duration);
      } else {
        // Check if this is a missing baseline (should be skipped)
        const isMissingBaseline =
          lastError &&
          (String(lastError).includes('Missing baseline') ||
            String(lastError).includes('Could not load base image'));

        if (isMissingBaseline) {
          // Skipped - no snapshot exists
          this.results[story.id] = {
            success: true, // Skipped is considered successful (not a failure)
            duration,
            action: 'skipped',
          };

          // Record result in results index (skip in update mode)
          if (!this.config.update && story.snapshotId) {
            const browser = this.config.browser || 'chromium';
            this.resultsIndexManager.setResult(story.id, story.snapshotId, 'missing', {
              browser,
              viewportName: displayViewportName,
              duration,
            });
          }

          // Notify callbacks of skipped result
          this.callbacks?.onResult?.({
            storyId: story.id,
            storyName: displayName,
            status: 'skipped',
            duration,
            action: 'skipped',
          });

          this.callbacks?.onStoryComplete?.({
            storyId: story.id,
            storyName: displayName,
            status: 'skipped',
            duration,
            action: 'skipped',
          });

          // Print result using unified method
          this.printStoryResult(displayName, 'skipped', duration, undefined, displayViewportName);
        } else {
          // Failed after all retries
          this.results[story.id] = {
            success: false,
            error: lastError ? String(lastError) : 'Unknown error',
            duration,
            action: 'failed',
          };

          // Record result in results index (skip in update mode)
          if (!this.config.update && story.snapshotId) {
            // Extract diff information from error message if available
            const errorStr = lastError ? String(lastError) : '';
            let diffPixels: number | undefined;
            let diffPercent: number | undefined;

            // Try to extract diff info from comparison result or error message
            if (comparisonResult) {
              diffPixels = comparisonResult.diffPixels;
              diffPercent = comparisonResult.diffPercent;
            } else {
              // Try to parse from error message: "X pixels differ (Y% of image)"
              const pixelsMatch = errorStr.match(/(\d+)\s+pixels\s+differ/);
              const percentMatch = errorStr.match(/\(([\d.]+)%\s+of\s+image\)/);
              if (pixelsMatch) {
                diffPixels = parseInt(pixelsMatch[1], 10);
              }
              if (percentMatch) {
                diffPercent = parseFloat(percentMatch[1]);
              }
            }

            const browser = this.config.browser || 'chromium';
            this.resultsIndexManager.setResult(story.id, story.snapshotId, 'failed', {
              browser,
              viewportName: displayViewportName,
              diffPixels,
              diffPercent,
              duration,
            });
          }

          // Check if maxFailures is reached IMMEDIATELY after recording failure
          // This must happen synchronously to prevent race conditions with parallel workers
          const failedCount = Object.values(this.results).filter(
            (r) => r.action === 'failed',
          ).length;
          this.log.debug(
            `Story ${story.id}: Failure count check - failed: ${failedCount}, maxFailures: ${this.config.maxFailures ?? 'unlimited'}`,
          );

          // Track if we need to stop after processing this error
          let shouldStop = false;
          if (this.config.maxFailures && failedCount >= this.config.maxFailures) {
            this.maxFailuresReached = true;
            shouldStop = true;
            const maxFailuresMessage = `Max failures (${this.config.maxFailures}) reached. Stopping test execution.`;
            this.log.warn(
              `Story ${story.id}: ${maxFailuresMessage} (failed: ${failedCount}/${this.config.maxFailures})`,
            );
            if (this.printUnderSpinner) {
              this.printUnderSpinner(maxFailuresMessage);
            } else {
              this.log.warn(maxFailuresMessage);
            }
            // Cancel all remaining tests IMMEDIATELY
            this.cancel();
          }

          // Extract diff image path from error message for visual regression failures
          const errorStr = lastError ? String(lastError) : '';
          const diffMatch = errorStr.match(/diff: (.+)\)/);
          let diffPath = diffMatch ? diffMatch[1] : null;

          // If no diff in error message but we have a timeout, check if screenshot was captured
          // and generate a diff to help debug the timeout
          if (!diffPath && /timeout/i.test(errorStr) && story.snapshotId) {
            try {
              const expected = this.indexManager.getSnapshotPath(
                story.snapshotId,
                this.config.snapshotPath,
                story.id,
              );
              const actual = this.resultsIndexManager.getResultPath(
                story.snapshotId,
                this.config.resultsPath,
                'actual',
                story.id,
              );
              if (fs.existsSync(actual) && fs.existsSync(expected)) {
                // Generate diff for timeout cases to show what was captured
                const timeoutDiffPath = this.resultsIndexManager.getResultPath(
                  story.snapshotId,
                  this.config.resultsPath,
                  'diff',
                  story.id,
                );
                try {
                  const odiffResult = await odiffCompare(expected, actual, timeoutDiffPath, {
                    threshold: this.config.threshold,
                    outputDiffMask: true,
                  });
                  if (!odiffResult.match && fs.existsSync(timeoutDiffPath)) {
                    diffPath = timeoutDiffPath;
                    this.log.debug(
                      `Story ${story.id}: Generated diff for timeout case: ${diffPath}`,
                    );
                  }
                } catch (diffError) {
                  this.log.debug(
                    `Story ${story.id}: Failed to generate diff on timeout: ${diffError}`,
                  );
                }
              }
            } catch (checkError) {
              this.log.debug(
                `Story ${story.id}: Error checking for timeout screenshot: ${checkError}`,
              );
            }
          }

          // Notify callbacks of failed result
          this.callbacks?.onResult?.({
            storyId: story.id,
            storyName: displayName,
            status: 'failed',
            duration,
            error: lastError ? String(lastError) : 'Unknown error',
            diffPath,
            actualPath: undefined, // Could be extracted from error if needed
            expectedPath: undefined, // Could be extracted from error if needed
            errorPath: diffPath, // Use diff path as error path for now
            errorType: 'screenshot_mismatch',
          });

          this.callbacks?.onStoryComplete?.({
            storyId: story.id,
            storyName: displayName,
            status: 'failed',
            duration,
            error: lastError ? String(lastError) : 'Unknown error',
            diffPath,
            actualPath: undefined,
            expectedPath: undefined,
            errorPath: diffPath,
            errorType: 'screenshot_mismatch',
          });

          // Extract error details for printing
          // Use the diffPath we computed (which may include timeout-generated diffs)
          const printDiffPath = diffPath || undefined;

          // Extract a user-friendly error message
          let errorReason = 'Unknown error';
          if (lastError) {
            const errorStr = String(lastError);
            const isImagesDiffer = /images differ/i.test(errorStr);
            const isOdiffFailed = /odiff comparison failed/i.test(errorStr);
            if (errorStr.includes('Missing baseline')) {
              errorReason = 'No baseline snapshot found';
            } else if (errorStr.includes('Could not load base image')) {
              errorReason = 'Baseline snapshot file not found or corrupted';
            } else if (isImagesDiffer) {
              errorReason = 'Visual differences detected';
            } else if (isOdiffFailed) {
              errorReason = 'Image comparison failed (odiff)';
            } else if (/target crashed|page crashed/i.test(errorStr)) {
              errorReason = 'Browser crashed (likely due to resource constraints)';
            } else if (/timeout/i.test(errorStr) && story.snapshotId) {
              // Check if crash occurred during timeout
              const actual = this.resultsIndexManager.getResultPath(
                story.snapshotId,
                this.config.resultsPath,
                'actual',
                story.id,
              );
              if (!fs.existsSync(actual) && /target crashed|page crashed/i.test(errorStr)) {
                errorReason = 'Operation timed out (browser crashed before screenshot)';
              } else {
                errorReason = 'Operation timed out';
              }
            } else if (/network/i.test(errorStr)) {
              errorReason = 'Network error';
            } else if (errorStr.includes('Screenshot capture failed')) {
              // Extract the underlying reason from the error message
              // Format: "Screenshot capture failed: [reason]"
              const match = errorStr.match(/Screenshot capture failed:\s*(.+)/i);
              if (match && match[1]) {
                // Use the underlying reason, but truncate if too long
                const underlyingReason = match[1].trim();
                if (underlyingReason.length > 100) {
                  errorReason = `Failed to capture screenshot: ${underlyingReason.substring(0, 97)}...`;
                } else {
                  errorReason = `Failed to capture screenshot: ${underlyingReason}`;
                }
              } else {
                errorReason = 'Failed to capture screenshot';
              }
            } else {
              // Use the first line of the error as a summary
              errorReason = errorStr.split('\n')[0];
            }
          }

          // Print result using unified method
          // Use original URL (localhost) for display instead of transformed URL (host.docker.internal)
          let displayUrl = story.url;
          if (this.config.originalUrl) {
            try {
              const originalUrlObj = new URL(this.config.originalUrl);
              const storyUrlObj = new URL(story.url);
              displayUrl = story.url.replace(storyUrlObj.origin, originalUrlObj.origin);
            } catch {
              // Fall back to original URL if parsing fails
              displayUrl = story.url;
            }
          }
          const expected = story.snapshotId
            ? this.indexManager.getSnapshotPath(
                story.snapshotId,
                this.config.snapshotPath,
                story.id,
              )
            : path.join(this.config.snapshotPath, story.snapshotRelPath || '');
          this.printStoryResult(
            displayName,
            'failed',
            duration,
            {
              reason: errorReason,
              url: displayUrl,
              diffPath: printDiffPath,
              expectedPath: expected,
            },
            displayViewportName,
          );

          // If maxFailures was reached, stop processing immediately after printing the error
          if (shouldStop) {
            return;
          }
        } // End of else block for missing baseline check
      } // End of else block for cancelled check
    }

    this.completed++;
    this.onProgress?.(this.completed, this.total, this.results);
  }

  private async dumpPageStateOnTimeout(story: DiscoveredStory, page: Page): Promise<void> {
    try {
      // Check if page is still valid
      if (page.isClosed()) {
        this.log.debug(`Story ${story.id}: Page is closed, cannot dump state`);
        // Still create a minimal dump with error info
        const dumpDir = path.join(this.config.resultsPath, 'timeout-dumps');
        fs.mkdirSync(dumpDir, { recursive: true });
        const infoPath = path.join(dumpDir, `${story.id.replace(/[^a-z0-9-]/gi, '_')}.json`);
        fs.writeFileSync(
          infoPath,
          JSON.stringify(
            { error: 'Page closed before dump', storyId: story.id, url: story.url },
            null,
            2,
          ),
          'utf8',
        );
        return;
      }

      const dumpDir = path.join(this.config.resultsPath, 'timeout-dumps');
      fs.mkdirSync(dumpDir, { recursive: true });

      const dumpPath = path.join(dumpDir, `${story.id.replace(/[^a-z0-9-]/gi, '_')}.html`);
      const infoPath = path.join(dumpDir, `${story.id.replace(/[^a-z0-9-]/gi, '_')}.json`);

      // Get page HTML - wrap in try-catch in case page crashed
      let html = '<html><body>Page crashed or closed</body></html>';
      try {
        html = await page.content();
      } catch (err) {
        this.log.debug(`Story ${story.id}: Failed to get page content:`, err);
        html = `<html><body>Failed to get content: ${String(err)}</body></html>`;
      }

      // Get page state information - wrap in try-catch
      let pageInfo: Record<string, unknown> = {
        error: 'Failed to evaluate page state',
        storyId: story.id,
        url: story.url,
      };
      try {
        pageInfo = await page.evaluate(() => {
          try {
            const root = document.getElementById('storybook-root');
            return {
              url: window.location.href,
              readyState: document.readyState,
              title: document.title,
              storybookRoot: {
                exists: !!root,
                childrenCount: root?.children.length ?? 0,
                textContentLength: root?.textContent?.length ?? 0,
                innerHTMLLength: root?.innerHTML.length ?? 0,
                hasCanvas: !!root?.querySelector('canvas'),
              },
              consoleErrors: (window as any).__consoleErrors || [],
              networkErrors: (window as any).__networkErrors || [],
            };
          } catch (e) {
            return {
              error: `Evaluation error: ${String(e)}`,
              url: window.location.href,
            };
          }
        });
      } catch (err) {
        this.log.debug(`Story ${story.id}: Failed to evaluate page state:`, err);
        pageInfo = {
          error: `Evaluation failed: ${String(err)}`,
          storyId: story.id,
          url: story.url,
        };
      }

      // Write HTML dump
      fs.writeFileSync(dumpPath, html, 'utf8');

      // Write info dump
      fs.writeFileSync(infoPath, JSON.stringify(pageInfo, null, 2), 'utf8');

      // Try to get console messages
      const consoleMessages = await page
        .evaluate(() => {
          return (window as any).__consoleMessages || [];
        })
        .catch(() => []);

      if (consoleMessages.length > 0) {
        const consolePath = path.join(
          dumpDir,
          `${story.id.replace(/[^a-z0-9-]/gi, '_')}.console.txt`,
        );
        fs.writeFileSync(
          consolePath,
          consoleMessages.map((m: any) => `${m.type}: ${m.text}`).join('\n'),
          'utf8',
        );
      }

      this.log.warn(`Story ${story.id}: Timeout detected. DOM dump saved to: ${dumpPath}`);
      this.log.warn(`Story ${story.id}: Page state info saved to: ${infoPath}`);
    } catch (error) {
      this.log.debug(`Story ${story.id}: Failed to dump page state:`, error);
    }
  }

  /**
   * Execute a single test attempt for a given story and viewport
   * @param story - The story to test
   * @param viewport - The viewport to test in
   * @returns A promise that resolves to the test result
   */
  private async executeSingleTestAttempt(
    story: DiscoveredStory,
    viewport?: { width: number; height: number },
  ): Promise<{
    result: string;
    page?: Page;
    actualViewport?: { width: number; height: number };
    viewportName?: string;
    comparisonResult?: InMemoryComparisonResult;
  }> {
    let browser: Browser | undefined;
    let page: Page | undefined;
    let viewportName: string | undefined;

    try {
      const browserStart = Date.now();
      this.log.debug(`Story ${story.id}: Launching browser...`);
      // Launch browser with aggressive memory optimization for parallel execution
      // Add proxy-related flags for CI environments behind proxies
      const browserArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--memory-pressure-off', // Prevent memory pressure handling
        '--max_old_space_size=4096', // Increase Node.js heap size
        '--disable-features=VizDisplayCompositor', // Reduce GPU memory usage
        '--disable-web-security', // Reduce security checks
        '--disable-features=VizDisplayCompositor,VizHitTestSurfaceLayer',
        '--disable-ipc-flooding-protection', // Reduce IPC overhead
        '--disable-hang-monitor', // Disable hang monitoring
        '--disable-prompt-on-repost', // Disable repost prompts
        '--force-color-profile=srgb', // Force color profile
        '--disable-component-extensions-with-background-pages', // Reduce extensions
        '--no-default-browser-check', // Skip default browser check
        '--no-first-run', // Skip first run checks
        '--disable-default-apps', // Disable default apps
        '--disable-sync', // Disable sync
        '--hide-crash-restore-bubble', // Hide crash restore
        '--disable-component-update', // Disable component updates
        '--font-render-hinting=none', // Disable font hinting for consistency
        '--disable-font-subpixel-positioning', // Disable subpixel positioning
        '--disable-lcd-text', // Disable LCD text rendering
        '--force-device-scale-factor=1', // Force consistent device scale
        '--disable-background-networking', // Reduce background network activity
        '--disable-breakpad', // Disable crash reporting
        '--disable-client-side-phishing-detection', // Reduce overhead
        '--disable-domain-reliability', // Disable domain reliability
        '--disable-features=TranslateUI', // Disable translation UI
        '--metrics-recording-only', // Reduce metrics overhead
        '--mute-audio', // Mute audio
        '--no-pings', // Disable pings
        '--use-gl=swiftshader', // Use software rendering for consistency
        '--ignore-certificate-errors', // Ignore certificate errors (for proxy environments)
        '--ignore-certificate-errors-spki-list', // Ignore certificate errors
        '--ignore-ssl-errors', // Ignore SSL errors
      ];

      browser = await chromium.launch({
        headless: true,
        args: browserArgs,
      });
      this.log.debug(`Story ${story.id}: Browser launched in ${Date.now() - browserStart}ms`);

      // Check for cancellation after browser launch
      if (this.cancelled || this.maxFailuresReached) {
        this.log.debug(`Story ${story.id}: Test cancelled after browser launch, cleaning up`);
        if (browser.isConnected()) {
          await browser.close();
        }
        throw new Error('Test cancelled');
      }

      this.log.debug(
        `Story ${story.id}: Creating browser context${viewport ? ` with viewport: ${JSON.stringify(viewport)}` : ''}...`,
      );
      // Configure context with proxy settings if available (for CI environments)
      const contextOptions: Parameters<typeof browser.newContext>[0] = {
        viewport: viewport,
        // Ignore HTTPS errors in CI - proxy might interfere
        ignoreHTTPSErrors: true,
      };

      const context = await browser.newContext(contextOptions);

      // Fix date using context addInitScript - this runs before any page JavaScript executes
      // This ensures React components see the fixed date from the start
      if (this.config.fixDate) {
        const fixedDate = parseFixDate(this.config.fixDate);
        const fixedTimestamp = fixedDate.getTime();
        await context.addInitScript((timestamp: number) => {
          const fixedTime = timestamp;
          const OriginalDate = window.Date;

          // Override Date.now() immediately
          OriginalDate.now = function () {
            return fixedTime;
          };

          // Replace Date constructor
          function MockDate(this: any, ...args: any[]) {
            if (this instanceof MockDate) {
              if (args.length === 0) {
                return new OriginalDate(fixedTime);
              }
              return new (OriginalDate as any)(...args);
            }
            return new OriginalDate(fixedTime).toString();
          }

          Object.setPrototypeOf(MockDate, OriginalDate);
          MockDate.prototype = OriginalDate.prototype;
          MockDate.now = () => fixedTime;
          MockDate.parse = OriginalDate.parse;
          MockDate.UTC = OriginalDate.UTC;

          (window as any).Date = MockDate;
          (globalThis as any).Date = MockDate;
        }, fixedTimestamp);
        this.log.debug(
          `Story ${story.id}: Date fix init script added to context (${fixedDate.toISOString()})`,
        );
      }

      page = await context.newPage();
      this.log.debug(`Story ${story.id}: New page created`);

      // Set page-level timeouts to prevent hanging in CI environments
      // Use testTimeout config or default to 60 seconds for slower environments
      const pageTimeout = this.config.testTimeout ?? 60000;
      this.log.debug(
        `Story ${story.id}: Setting page timeouts to ${pageTimeout}ms (config.testTimeout: ${this.config.testTimeout ?? 'not set'})`,
      );
      page.setDefaultNavigationTimeout(pageTimeout);
      page.setDefaultTimeout(pageTimeout);

      // Disable animations if configured
      if (this.config.disableAnimations) {
        await page.addInitScript(() => {
          // Inject CSS to disable all animations and transitions
          const disableAnimations = () => {
            const style = document.createElement('style');
            style.textContent = `
              *, *::before, *::after {
                animation-duration: 0s !important;
                animation-delay: 0s !important;
                transition-duration: 0s !important;
                transition-delay: 0s !important;
                scroll-behavior: auto !important;
              }
            `;
            document.head.appendChild(style);

            // Override getComputedStyle to return 0s for animations/transitions
            const originalGetComputedStyle = window.getComputedStyle;
            window.getComputedStyle = function (element: Element, pseudoElement?: string | null) {
              const style = originalGetComputedStyle.call(window, element, pseudoElement);
              try {
                Object.defineProperty(style, 'animationDuration', {
                  get: () => '0s',
                  configurable: true,
                });
                Object.defineProperty(style, 'transitionDuration', {
                  get: () => '0s',
                  configurable: true,
                });
              } catch {
                // If property override fails, CSS injection should still work
              }
              return style;
            };
          };

          // Run immediately if document is ready, otherwise wait for DOMContentLoaded
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', disableAnimations, { once: true });
          } else {
            disableAnimations();
          }
        });
      }

      // Check for cancellation before navigation
      if (this.cancelled || this.maxFailuresReached) {
        this.log.debug(`Story ${story.id}: Test cancelled before navigation, cleaning up`);
        await browser.close();
        throw new Error('Test cancelled');
      }

      // Navigate and wait for story to load
      // Page-level timeouts are already set above
      // Use 'commit' first - it fires immediately when response headers are received
      // This avoids hanging if domcontentloaded is blocked by something in CI
      // Note: Date fix is already applied via context.addInitScript above
      this.log.debug(`Story ${story.id}: Navigating to ${story.url}...`);
      const navStart = Date.now();

      // Start navigation with 'commit' - fastest, doesn't wait for body
      // Use pageTimeout from config (or default 60s)
      await page.goto(story.url, { waitUntil: 'commit', timeout: pageTimeout });
      this.log.debug(`Story ${story.id}: Navigation committed in ${Date.now() - navStart}ms`);

      // Now wait for the page to actually be ready, but with a timeout to avoid hanging
      // Try domcontentloaded first, but fall back to just checking readyState if it hangs
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: pageTimeout });
        this.log.debug(`Story ${story.id}: DOMContentLoaded reached in ${Date.now() - navStart}ms`);
      } catch {
        // domcontentloaded might be blocked, check readyState directly instead
        this.log.debug(
          `Story ${story.id}: Waiting for DOMContentLoaded timed out, checking readyState directly...`,
        );
        await page.waitForFunction(
          () => document.readyState === 'complete' || document.readyState === 'interactive',
          { timeout: pageTimeout },
        );
        this.log.debug(
          `Story ${story.id}: Document readyState confirmed in ${Date.now() - navStart}ms`,
        );
      }

      this.log.debug(`Story ${story.id}: Navigation completed in ${Date.now() - navStart}ms`);

      // Check for cancellation before waiting for root
      if (this.cancelled || this.maxFailuresReached) {
        this.log.debug(`Story ${story.id}: Test cancelled before waiting for root, cleaning up`);
        await browser.close();
        throw new Error('Test cancelled');
      }

      // // Wait for Storybook root to be attached
      // this.log.debug(`Story ${story.id}: Waiting for #storybook-root...`);
      // await page.waitForSelector('#storybook-root', { state: 'attached', timeout: pageTimeout });
      // this.log.debug(`Story ${story.id}: Storybook root found`);

      // Verify Date mock is working (it was injected via evaluateOnNewDocument before navigation)
      if (this.config.fixDate && !page.isClosed()) {
        try {
          const fixedDate = parseFixDate(this.config.fixDate);
          const verification = await page.evaluate((expectedTime: number) => {
            return {
              newDate: new Date().toISOString(),
              dateNow: Date.now(),
              expected: expectedTime,
              matches: Date.now() === expectedTime,
            };
          }, fixedDate.getTime());
          this.log.debug(
            `Story ${story.id}: Date mock verification - new Date(): ${verification.newDate}, Date.now(): ${verification.dateNow}, matches: ${verification.matches}`,
          );
        } catch (e) {
          this.log.debug(`Story ${story.id}: Date mock verification failed:`, e);
        }
      }

      await page.waitForSelector('body.sb-show-main', { timeout: pageTimeout });
      await page.waitForSelector('#storybook-root', { timeout: pageTimeout });

      // Wait for the storybook root to have content (not be empty)
      await page.waitForFunction(
        () => {
          const root = document.getElementById('storybook-root');
          if (!root) return false;

          // Check multiple indicators of content:
          // 1. Has children elements
          // 2. Has innerHTML content
          // 3. Has text content with visual dimensions
          // 4. Has canvas/SVG elements (for graphics-heavy stories)
          const hasChildren = root.children.length > 0;
          const hasHTML = root.innerHTML.trim().length > 0;
          const hasText = !!(root.textContent && root.textContent.trim().length > 0);
          const hasDimensions = root.offsetHeight > 0 && root.offsetWidth > 0;
          const hasGraphics = !!root.querySelector('canvas, svg');

          return hasChildren || hasHTML || (hasText && hasDimensions) || hasGraphics;
        },
        { timeout: pageTimeout },
      );

      if (this.config.storyLoadDelay) {
        await page.waitForTimeout(this.config.storyLoadDelay);
      }

      // Get the viewport name from Storybook's channel and look up dimensions from config
      let actualViewport: { width: number; height: number } | undefined;
      try {
        if (!page.isClosed()) {
          // Read viewport name from Storybook's addon channel
          const channelData = await page.evaluate(() => {
            type StorybookChannel = {
              data?: {
                globalsUpdated?: Array<{
                  globals?: {
                    viewport?: {
                      value?: string;
                    };
                  };
                }>;
                setGlobals?: Array<{
                  globals?: {
                    viewport?: {
                      value?: string;
                    };
                  };
                }>;
              };
            };

            const windowWithChannel = window as typeof window & {
              __STORYBOOK_ADDONS_CHANNEL__?: StorybookChannel;
            };

            if (typeof windowWithChannel.__STORYBOOK_ADDONS_CHANNEL__ !== 'undefined') {
              const channel = windowWithChannel.__STORYBOOK_ADDONS_CHANNEL__;
              const data = channel?.data || {};

              // Try to get from globalsUpdated (most recent)
              const globalsUpdated = data.globalsUpdated;
              if (globalsUpdated && Array.isArray(globalsUpdated) && globalsUpdated.length > 0) {
                const lastUpdate = globalsUpdated[globalsUpdated.length - 1];
                if (lastUpdate?.globals?.viewport?.value) {
                  return lastUpdate.globals.viewport.value;
                }
              }

              // Fallback: try setGlobals
              const setGlobals = data.setGlobals;
              if (setGlobals && Array.isArray(setGlobals) && setGlobals.length > 0) {
                const lastSet = setGlobals[setGlobals.length - 1];
                if (lastSet?.globals?.viewport?.value) {
                  return lastSet.globals.viewport.value;
                }
              }

              return null;
            }
            return null;
          });

          if (channelData) {
            viewportName = channelData;
            this.log.debug(
              `Story ${story.id}: Found viewport name from Storybook channel: "${viewportName}"`,
            );

            // Look up viewport dimensions from config
            const viewportConfig = this.config.viewportSizes.find((v) => v.name === viewportName);
            if (viewportConfig) {
              actualViewport = { width: viewportConfig.width, height: viewportConfig.height };
              this.log.debug(
                `Story ${story.id}: Found viewport "${viewportName}" in config: ${actualViewport.width}×${actualViewport.height}`,
              );

              // Set the page viewport size to match the story's viewport
              await page.setViewportSize(actualViewport);
              this.log.debug(
                `Story ${story.id}: Set page viewport size to ${actualViewport.width}×${actualViewport.height} for viewport "${viewportName}"`,
              );

              // Wait a bit for Storybook to re-render with the correct viewport
              await page.waitForTimeout(100);
            } else {
              this.log.debug(
                `Story ${story.id}: Viewport "${viewportName}" not found in config, using default`,
              );
              // Fallback to configured viewport or window dimensions
              const dimensions = await page.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight,
              }));
              actualViewport = { width: dimensions.width, height: dimensions.height };
            }
          } else {
            // Fallback: use window dimensions or configured viewport
            const dimensions = await page.evaluate(() => ({
              width: window.innerWidth,
              height: window.innerHeight,
            }));
            actualViewport = { width: dimensions.width, height: dimensions.height };
            this.log.debug(
              `Story ${story.id}: Could not read viewport from Storybook channel, using window dimensions: ${actualViewport.width}×${actualViewport.height}`,
            );
          }
        }
      } catch (e) {
        this.log.debug(`Story ${story.id}: Failed to get viewport from Storybook channel:`, e);
        // Fall back to configured viewport
        actualViewport = viewport;
      }

      if (this.config.domStabilityQuietPeriod) {
        // Wait for DOM to stabilize: configurable quiet period after last mutation, with max wait timeout
        const quietPeriodMs: number = Number(this.config.domStabilityQuietPeriod);
        const maxWaitMs: number = Number(this.config.domStabilityMaxWait);

        const isStable = await page.evaluate(
          ({ quietPeriodMs, maxWaitMs }) => {
            return new Promise<boolean>((resolve) => {
              // Use performance.now() for timing to avoid issues with mocked Date.now()
              const start = performance.now();
              let lastMutation = performance.now();

              const obs = new MutationObserver(() => {
                lastMutation = performance.now();
              });

              obs.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
              });

              const checkStability = () => {
                const now = performance.now();
                const timeSinceLastMutation = now - lastMutation;
                const totalTime = now - start;

                if (timeSinceLastMutation >= quietPeriodMs) {
                  // DOM has been stable for quietPeriodMs
                  obs.disconnect();
                  resolve(true);
                } else if (totalTime >= maxWaitMs) {
                  // We've waited long enough, proceed anyway
                  obs.disconnect();
                  resolve(false);
                } else {
                  // Keep checking
                  setTimeout(checkStability, 10);
                }
              };

              checkStability();
            });
          },
          { quietPeriodMs, maxWaitMs },
        );

        if (!isStable) {
          this.log.debug(
            `Story ${story.id}: DOM still mutating after ${maxWaitMs}ms, taking screenshot anyway`,
          );
        } else {
          this.log.debug(`Story ${story.id}: DOM is stable`);
        }
      }

      // Check for cancellation before screenshot
      if (this.cancelled || this.maxFailuresReached) {
        this.log.debug(`Story ${story.id}: Test cancelled before screenshot, cleaning up`);
        await browser.close();
        throw new Error('Test cancelled');
      }

      // Optimized screenshot capture - capture to buffer in memory
      // Get snapshot ID with viewport name if available (creates separate entries for each viewport)
      const browserName = this.config.browser || 'chromium';
      const snapshotBasePath = this.config.snapshotPath;
      let snapshotId = story.snapshotId;
      if (viewportName) {
        // Get or create snapshot ID for this specific viewport
        snapshotId = this.indexManager.getSnapshotId(
          story.id,
          browserName,
          viewportName,
          snapshotBasePath,
        );
        // Update story's snapshotId for this viewport
        story.snapshotId = snapshotId;
      } else if (!snapshotId) {
        // Fallback: get snapshot ID without viewport name
        snapshotId = this.indexManager.getSnapshotId(
          story.id,
          browserName,
          undefined,
          snapshotBasePath,
        );
        story.snapshotId = snapshotId;
      }

      if (!snapshotId) {
        throw new Error(`Story ${story.id} has no snapshotId assigned`);
      }
      const expected = this.indexManager.getSnapshotPath(
        snapshotId,
        this.config.snapshotPath,
        story.id,
      );
      const actual = this.resultsIndexManager.getResultPath(
        snapshotId,
        this.config.resultsPath,
        'actual',
        story.id,
      );
      const diffPath = this.resultsIndexManager.getResultPath(
        snapshotId,
        this.config.resultsPath,
        'diff',
        story.id,
      );

      this.log.debug(
        `Story ${story.id}: Screenshot paths - expected: ${expected}, actual: ${actual}`,
      );

      // Verify page is still open before attempting screenshot
      if (page.isClosed()) {
        const errorMsg = `Page was closed before screenshot could be captured`;
        this.log.error(`Story ${story.id}: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Capture screenshot to buffer (in memory) - no file system operations needed yet
      this.log.debug(
        `Story ${story.id}: Capturing screenshot${this.config.fullPage ? ' (full page)' : ''}...`,
      );
      const screenshotStart = Date.now();
      let actualBuffer: Buffer;
      try {
        actualBuffer = (await page.screenshot({
          fullPage: this.config.fullPage,
          type: 'png', // PNG format required for accurate comparison
        })) as Buffer;
        this.log.debug(
          `Story ${story.id}: Screenshot captured in ${Date.now() - screenshotStart}ms`,
        );
      } catch (screenshotError) {
        const errorMsg = String(screenshotError);
        const errorDetails = screenshotError instanceof Error ? screenshotError.message : errorMsg;
        this.log.error(`Story ${story.id}: Screenshot capture failed: ${errorMsg}`);

        // Check if page closed during screenshot
        if (page.isClosed()) {
          throw new Error(`Screenshot capture failed: page closed during capture. ${errorDetails}`);
        }

        // Check for specific error types and provide more context
        if (/timeout|Timed out/i.test(errorMsg)) {
          throw new Error(`Screenshot capture failed: operation timed out. ${errorDetails}`);
        } else if (/Target crashed|page crashed|browser crashed/i.test(errorMsg)) {
          throw new Error(`Screenshot capture failed: browser/page crashed. ${errorDetails}`);
        } else if (/Protocol error/i.test(errorMsg)) {
          throw new Error(`Screenshot capture failed: protocol error. ${errorDetails}`);
        }

        throw new Error(`Screenshot capture failed: ${errorDetails}`);
      }

      // Handle baseline logic with in-memory comparison
      const missingBaseline = !fs.existsSync(expected);
      let result: string;

      this.log.debug(
        `Story ${story.id}: Baseline check - expected: ${expected}, missing: ${missingBaseline}, update mode: ${this.config.update}`,
      );

      // Helper to ensure directory exists (only needed when writing files)
      const ensureDirectoryExists = (filePath: string): void => {
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
      };

      let comparisonResult: InMemoryComparisonResult | undefined;

      if (this.config.update) {
        // In update mode, write screenshot buffer to expected location only
        // Don't write to results directory - we're updating baselines, not running tests
        ensureDirectoryExists(expected);
        fs.writeFileSync(expected, actualBuffer);
        result = missingBaseline ? 'Created baseline' : 'Updated baseline';
        this.log.debug(`Story ${story.id}: ${result}`);

        // Snapshot entry already has viewport name from getSnapshotId call above

        comparisonResult = { match: true, diffPixels: 0, diffPercent: 0 }; // Update mode - no diff
      } else if (missingBaseline) {
        this.log.debug(`Story ${story.id}: Missing baseline, skipping test`);
        throw new Error(`Missing baseline: ${expected}`);
      } else {
        // Perform visual regression test using in-memory comparison
        try {
          // Load baseline from file
          const expectedBuffer = fs.readFileSync(expected);

          // Compare images in memory
          const compareStart = Date.now();
          this.log.debug(
            `Story ${story.id}: Comparing images in memory (threshold: ${this.config.threshold})`,
          );

          // Log buffer sizes for debugging
          this.log.debug(
            `Story ${story.id}: Image buffers - actual: ${actualBuffer.length} bytes, expected: ${expectedBuffer.length} bytes`,
          );

          const comparisonResultData = compareImagesInMemory(
            actualBuffer,
            expectedBuffer,
            this.config.threshold,
          );
          comparisonResult = comparisonResultData;

          this.log.debug(
            `Story ${story.id}: Comparison completed in ${Date.now() - compareStart}ms, match: ${comparisonResultData.match}, diffPixels: ${comparisonResultData.diffPixels}, diffPercent: ${comparisonResultData.diffPercent.toFixed(2)}%, threshold: ${this.config.threshold}%`,
          );

          // If images match but there are differences, log a warning
          if (comparisonResultData.match && comparisonResultData.diffPixels > 0) {
            this.log.debug(
              `Story ${story.id}: Images match within threshold but have ${comparisonResultData.diffPixels} differing pixels (${comparisonResultData.diffPercent.toFixed(2)}%)`,
            );
          }

          if (comparisonResultData.match) {
            // Images are identical within threshold - test passed
            // No need to write files when images match - comparison is done in memory
            result = 'Visual regression passed';
            this.log.debug(`Story ${story.id}: Visual regression test passed (no files written)`);
          } else {
            // Images differ beyond threshold - write files for display
            this.log.debug(
              `Story ${story.id}: Images differ - reason: ${comparisonResultData.reason}`,
            );

            // Ensure directories exist before writing files
            ensureDirectoryExists(actual);
            ensureDirectoryExists(diffPath);

            // Write actual screenshot
            fs.writeFileSync(actual, actualBuffer);

            // Write diff image if available
            if (comparisonResultData.diffImage) {
              fs.writeFileSync(diffPath, comparisonResultData.diffImage);
              this.log.debug(`Story ${story.id}: Diff image saved to: ${diffPath}`);
            }

            throw new Error(
              `Visual regression failed: images differ (${comparisonResultData.reason || 'unknown reason'}, diff: ${diffPath})`,
            );
          }
        } catch (error: any) {
          // If it's our own error (visual regression failed), files are already written, just re-throw
          if (error?.message && error.message.includes('Visual regression failed')) {
            throw error;
          }

          // For comparison errors (not mismatches), write the actual screenshot for debugging
          // This handles cases like file read errors, corrupted images, etc.
          ensureDirectoryExists(actual);
          fs.writeFileSync(actual, actualBuffer);

          // Check for missing baseline file error
          const errMsg = error?.message || String(error);
          if (errMsg.includes('ENOENT') || errMsg.includes('no such file')) {
            if (!fs.existsSync(expected)) {
              const cmdName = getCommandName();
              this.log.error(
                `Story ${story.id}: Baseline file does not exist: ${expected}. Run '${cmdName} update' to create baseline.`,
              );
              this.log.debug(`Story ${story.id}: Actual screenshot saved to: ${actual}`);
              throw new Error(`Missing baseline: ${expected}`);
            } else {
              // File exists but can't be read - might be corrupted
              this.log.error(
                `Story ${story.id}: Baseline file exists but cannot be read (possibly corrupted): ${expected}`,
              );
              this.log.debug(`Story ${story.id}: Actual screenshot saved to: ${actual}`);
              throw new Error(`Could not read baseline image: ${expected}`);
            }
          }

          // For other comparison errors, write files for debugging
          this.log.error(`Story ${story.id}: Comparison failed: ${errMsg}`);
          this.log.debug(`Story ${story.id}: Actual screenshot saved to: ${actual}`);
          throw new Error(`Image comparison failed: ${errMsg}`);
        }
      }

      return {
        result,
        page,
        actualViewport,
        viewportName,
        comparisonResult: comparisonResult || undefined,
      };
    } finally {
      // Aggressive cleanup to prevent memory leaks
      try {
        if (page && !page.isClosed()) {
          // Close page first if it's still open
          await page.close();
        }
        if (browser && browser.isConnected()) {
          // Then close browser
          await browser.close();
        }
      } catch (e) {
        // Ignore cleanup errors but log for debugging
        this.log.debug(`Warning: Failed to close browser/page for ${story.id}:`, e);
      }

      // Force garbage collection if available (Node.js with --expose-gc)
      if (typeof global !== 'undefined' && global.gc) {
        global.gc();
      }
    }
  }
}

export async function runParallelTests(options: {
  stories: DiscoveredStory[];
  config: TestConfig;
  runtimePath: string;
  debug: boolean;
  callbacks?: RunCallbacks;
  indexManager: SnapshotIndexManager;
  resultsIndexManager: ResultsIndexManager;
}): Promise<number> {
  const { stories, config, debug, callbacks, indexManager, resultsIndexManager } = options;
  // Initialize global logger
  setGlobalLogger(config.logLevel);
  const log = createLogger(config.logLevel);

  log.debug(`Starting parallel test run with ${stories.length} stories`);
  log.debug(
    `Configuration: workers=${config.workers || 'default'}, maxFailures=${config.maxFailures ?? 'unlimited'}, threshold=${config.threshold}, update=${config.update}`,
  );
  log.debug(
    `Log level: ${config.logLevel}, quiet: ${config.quiet}, summary: ${config.summary}, progress: ${config.showProgress}`,
  );

  if (stories.length === 0) {
    log.error('No stories to test');
    return 1;
  }

  log.debug(`Output mode: ${config.showProgress ? 'spinner' : 'streaming'}`);
  log.debug(
    `Timeouts: testTimeout=${config.testTimeout ?? 'default (60000ms)'}, overlayTimeout=${config.overlayTimeout ?? 'default'}`,
  );

  // Use workers from config (defaults to CPU cores)
  const numWorkers = config.workers ?? os.cpus().length;
  log.debug(`Using ${numWorkers} workers (${os.cpus().length} CPU cores)`);

  // In test mode, filter out stories that don't have snapshots
  let filteredStories = stories;
  if (!config.update) {
    filteredStories = stories.filter((story) => {
      if (!story.snapshotId) {
        log.debug(`Skipping story ${story.id}: no snapshot ID assigned`);
        return false;
      }
      const snapshotPath = indexManager.getSnapshotPath(
        story.snapshotId,
        config.snapshotPath,
        story.id,
      );
      const hasSnapshot = fs.existsSync(snapshotPath);
      if (!hasSnapshot) {
        log.debug(`Skipping story ${story.id}: no baseline snapshot exists`);
      }
      return hasSnapshot;
    });

    const skippedCount = stories.length - filteredStories.length;
    if (skippedCount > 0) {
      const cmdName = getCommandName();
      log.info(
        `Skipped ${skippedCount} stories with no baseline snapshots (run '${cmdName} update' to create them)`,
      );
    }
  }
  // Log fixDate configuration once before tests start
  if (config.fixDate) {
    const fixedDate = parseFixDate(config.fixDate);
    log.info(
      `Date fixing enabled - config value: ${JSON.stringify(config.fixDate)}, fixed date: ${fixedDate.toISOString()}`,
    );
  }

  const storyCount = filteredStories.length;
  const workerDisplay = numWorkers === 0 ? '1 (scaling dynamically)' : String(numWorkers);
  const initialMessage = `Checking ${chalk.yellow(String(storyCount))} stories using ${chalk.yellow(workerDisplay)} concurrent workers...`;
  if (!config.quiet) {
    log.info('');
    log.info(chalk.bold(initialMessage));
    log.info('');
  }

  // Helper to print a line under the spinner and then resume spinner
  // If keepStopped is true, the spinner will not be resumed immediately (useful for errors)
  // It will resume automatically after a short delay or on the next progress update
  const printUnderSpinner = (line: string, keepStopped = false) => {
    if (spinner) {
      spinner.stop();
      spinner.clear();
      log.info(line);
      if (!keepStopped) {
        spinner = ora(spinnerText).start();
      } else {
        // For errors, resume spinner after a short delay to ensure error is visible
        // The spinner will also resume naturally on the next progress update
        setTimeout(() => {
          if (spinner && !spinner.isSpinning) {
            spinner = ora(spinnerText).start();
          }
        }, 100);
      }
    } else {
      log.info(line);
    }
  };

  const pool = new WorkerPool(
    numWorkers,
    config,
    filteredStories,
    printUnderSpinner,
    callbacks,
    indexManager,
    resultsIndexManager,
  );

  // Track current worker count for status display
  const currentWorkers = numWorkers;

  const startTime = Date.now();

  // Create ora spinner when --progress is passed (not when only --summary is passed)
  let spinner = config.showProgress ? ora() : null;
  let spinnerText = '';
  if (spinner) {
    // Initialize with a starting line so users see it immediately
    const initialPercent = 0;
    const initialText = ` 0/${stories.length} (${initialPercent}%) ${chalk.dim('•')} estimating...`;
    spinner = spinner.start(initialText);
    spinnerText = initialText;
  }

  // Time remaining tracking with rolling average
  const timeRemainingHistory: number[] = []; // Rolling window of time estimates (in seconds)
  let timeCountdownInterval: NodeJS.Timeout | null = null; // Declare early for cleanup

  // Handle Ctrl+C: stop spinner immediately and show aborted message
  let abortHandled = false;
  const handleSigint = () => {
    if (abortHandled) return;
    abortHandled = true;
    if (timeCountdownInterval) {
      clearInterval(timeCountdownInterval);
      timeCountdownInterval = null;
    }
    if (spinner) {
      try {
        spinner.stop();
        spinner.clear();
      } catch {}
    }
    log.error('Aborted by user. Visual regression run stopped.');
    process.exit(130);
  };
  process.once('SIGINT', handleSigint);
  let smoothedTimeRemaining = 0; // Smoothed time remaining in seconds
  const TIME_SAMPLE_WINDOW = 20; // Keep last 5 estimates

  // Function to update time remaining estimate
  const updateTimeRemaining = (completed: number, total: number) => {
    const elapsed = Date.now() - startTime;
    const avgTimePerTest = elapsed / Math.max(completed, 1);
    const remaining = (total - completed) * avgTimePerTest;
    const remainingSeconds = Math.round(remaining / 1000);

    // Add to rolling window
    timeRemainingHistory.push(remainingSeconds);
    if (timeRemainingHistory.length > TIME_SAMPLE_WINDOW) {
      timeRemainingHistory.shift();
    }

    // Calculate rolling average
    if (timeRemainingHistory.length > 0) {
      const sum = timeRemainingHistory.reduce((a, b) => a + b, 0);
      smoothedTimeRemaining = sum / timeRemainingHistory.length;
    }
  };

  // Function to format time remaining
  const formatTimeRemaining = (seconds: number): string => {
    const clamped = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(clamped / 60);
    const secs = clamped % 60;
    return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
  };

  // Function to update spinner display
  const updateSpinner = (completed: number, total: number) => {
    if (!spinner) return;

    const percent = Math.round((completed / total) * 100);
    const elapsed = Date.now() - startTime;

    // Stories per minute (rounded, min 1 when there is progress)
    const elapsedMinutes = Math.max(elapsed / 60000, 0.001);
    const storiesPerMinute = completed > 0 ? Math.round(completed / elapsedMinutes) : 0;

    // Use smoothed time remaining
    const timeStr = formatTimeRemaining(smoothedTimeRemaining);

    // Get CPU usage from the pool (rolling average)
    const cpuUsagePercent = pool.getCurrentCpuUsage();

    // Build status line components
    const statusParts: (string | null)[] = [
      chalk.magenta(`Stories: ${completed}/${total} ${storiesPerMinute}/m ${percent}%`),
      chalk.cyan(`Remaining: ~${timeStr}`),
      chalk.yellow(`Workers: ${currentWorkers}`),
    ];

    // Add CPU usage if we have a valid measurement
    if (cpuUsagePercent > 0) {
      const loadColor =
        cpuUsagePercent < 50 ? chalk.green : cpuUsagePercent < 90 ? chalk.yellow : chalk.red;
      statusParts.push(loadColor(`CPU: ${cpuUsagePercent.toFixed(0)}%`));
    }

    spinnerText = ` ${statusParts.filter(Boolean).join(` ${chalk.dim('•')} `)}`;
    spinner.text = spinnerText;
  };

  // Progress callback
  const onProgress = (completed: number, total: number) => {
    lastCompletedCount = completed;
    // Update time remaining estimate
    if (completed > 0) {
      updateTimeRemaining(completed, total);
    }
    // Update spinner display
    updateSpinner(completed, total);
  };

  // Set up interval to decrement time and update display every second
  let lastCompletedCount = 0;
  if (spinner) {
    timeCountdownInterval = setInterval(() => {
      // Decrement smoothed time remaining by 1 second
      smoothedTimeRemaining = Math.max(0, smoothedTimeRemaining - 1);

      // Update display with current progress
      const currentCompleted = Object.keys(pool.getResults()).length;
      if (currentCompleted > 0 || lastCompletedCount > 0) {
        lastCompletedCount = currentCompleted;
        updateSpinner(currentCompleted, filteredStories.length);
      }
    }, 1000);
  }

  try {
    // Run the tests
    log.debug('Starting worker pool execution...');
    const { success, failed } = await pool.run(onProgress);
    log.debug(`Worker pool completed: success=${success}, failed=${failed}`);

    // Clear progress and show final summary
    if (timeCountdownInterval) {
      clearInterval(timeCountdownInterval);
      timeCountdownInterval = null;
    }
    if (spinner) {
      spinner.stop();
      spinner.clear();
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Calculate summary statistics from results
    const allResults = Object.values(pool.getResults());
    const passed = allResults.filter((r) => r.action === 'Visual regression passed').length;
    const updated = allResults.filter((r) => r.action === 'Updated baseline').length;
    const created = allResults.filter((r) => r.action === 'Created baseline').length;
    const failedCount = allResults.filter((r) => r.action === 'failed').length;
    const cancelled = allResults.filter((r) => r.action === 'cancelled').length;
    // Calculate skipped as the difference between original stories and filtered stories
    const skipped = stories.length - filteredStories.length;
    // Calculate stories per minute based on actually processed stories (not skipped ones)
    const actuallyProcessed = passed + failedCount + updated + created;
    const testsPerMinute =
      actuallyProcessed > 0
        ? (actuallyProcessed / (parseFloat(totalDuration) / 60)).toFixed(0)
        : '0';

    // Show detailed summary at the end when --summary is passed
    if (config.summary) {
      // Use original story count as total, not filtered count
      const totalStories = stories.length;
      const context: 'update' | 'test' = config.update ? 'update' : 'test';
      const successPercent =
        context === 'test'
          ? (passed / Math.max(totalStories, 1)) * 100
          : (updated / Math.max(totalStories, 1)) * 100;

      const message = generateSummaryMessage({
        passed,
        failed: failedCount,
        cancelled,
        skipped,
        created,
        updated,
        total: totalStories,
        successPercent,
        verbose: true,
        context,
        testsPerMinute,
        duration: totalDuration,
      });

      log.info('\n' + message);
    }

    return success ? 0 : 1;
  } catch (error) {
    if (spinner) {
      spinner.stop();
      spinner.clear();
    }
    log.error('Unexpected error:', error);
    return 1;
  }
}
