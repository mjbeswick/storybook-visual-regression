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
import chalk from 'chalk';
import type { RuntimeConfig } from './config.js';
import type { DiscoveredStory } from './core/StorybookDiscovery.js';
import type { RunCallbacks } from './core/VisualRegressionRunner.js';
import { createLogger, setGlobalLogger } from './logger.js';

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
}: SummaryParams): string {
  const lines: string[] = [];

  if (context === 'update') {
    if (updated === total && failed === 0) {
      lines.push(chalk.green(`${total} snapshots updated successfully.`));
    } else if (updated > 0 && failed > 0) {
      lines.push(chalk.yellow(`${updated} snapshots updated, ${failed} failed.`));
    } else if (failed === total) {
      lines.push(chalk.red(`All ${total} snapshot updates failed.`));
    } else {
      lines.push(chalk.gray(`No snapshots were updated.`));
    }
  } else if (context === 'test') {
    if (passed === total && failed === 0) {
      lines.push(chalk.green(`All ${total} tests passed.`));
    } else if (passed > 0 && failed > 0) {
      lines.push(chalk.yellow(`${passed} tests passed, ${failed} failed.`));
    } else if (failed === total) {
      lines.push(chalk.red(`All ${total} tests failed.`));
    } else {
      lines.push(chalk.gray(`No tests were run.`));
    }
  }

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
  private maxWorkers: number = 1;
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
  private performanceHistory: Array<{ timestamp: number; completed: number; workers: number }> = [];
  private minWorkers = 1;
  private maxWorkersLimit = os.cpus().length * 2; // 2x the number of CPU cores
  private onWorkersChanged?: (workers: number) => void;
  private cpuMonitorInterval?: NodeJS.Timeout;
  private lastCpuUsage: {
    user: number;
    nice: number;
    sys: number;
    idle: number;
    irq: number;
  } | null = null;
  private currentCpuUsagePercent = 0;
  private readonly CPU_SAMPLE_WINDOW = 5; // Keep last 5 samples
  private cpuUsageHistory: number[] = []; // Rolling window of CPU samples

  constructor(
    maxWorkersLimit: number,
    config: TestConfig,
    stories: DiscoveredStory[],
    printUnderSpinner?: (line: string) => void,
    callbacks?: RunCallbacks,
  ) {
    this.maxWorkersLimit = maxWorkersLimit;
    this.config = config;
    this.total = stories.length;
    this.queue = [...stories];
    this.callbacks = callbacks;
    this.singleLineMode = Boolean(config.summary || config.showProgress);
    this.printUnderSpinner = printUnderSpinner;
    this.log = createLogger(config.logLevel);

    // Pre-calculate viewports for all stories
    this.preCalculateViewports();
  }

  setWorkersChangedCallback(callback: (workers: number) => void): void {
    this.onWorkersChanged = callback;
  }

  setMaxWorkers(newMax: number): void {
    const clamped = Math.max(this.minWorkers, Math.min(this.maxWorkersLimit, newMax));
    if (clamped !== this.maxWorkers) {
      const oldMax = this.maxWorkers;
      this.maxWorkers = clamped;
      this.log.debug(`Adjusting worker count: ${oldMax} -> ${clamped}`);
      this.onWorkersChanged?.(clamped);
      // Trigger spawning of additional workers if we increased
      if (
        clamped > oldMax &&
        this.queue.length > 0 &&
        !this.maxFailuresReached &&
        !this.cancelled
      ) {
        setImmediate(() => this.spawnWorker());
      }
    }
  }

  getMaxWorkers(): number {
    return this.maxWorkers;
  }

  getCurrentCpuUsage(): number {
    return this.currentCpuUsagePercent;
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

    // Calculate rolling average
    if (this.cpuUsageHistory.length > 0) {
      const sum = this.cpuUsageHistory.reduce((a, b) => a + b, 0);
      this.currentCpuUsagePercent = sum / this.cpuUsageHistory.length;
    }
  }

  private adjustWorkersBasedOnCpu(): void {
    if (this.maxFailuresReached || this.cancelled) {
      return;
    }

    // Use smoothed CPU usage for worker adjustment
    const smoothedCpuUsage = this.currentCpuUsagePercent;

    // Target CPU usage: just under 100% (aim for 95% as optimal)
    const TARGET_CPU_USAGE = 95;
    const CPU_TOLERANCE = 3; // Allow 3% variance

    // Need at least a few samples before making adjustments
    if (this.cpuUsageHistory.length < 5) {
      return;
    }

    // Gradually increase workers to maximize CPU usage
    // If CPU is significantly underutilized (< 90%) and we have work, increase workers
    if (
      smoothedCpuUsage < TARGET_CPU_USAGE - CPU_TOLERANCE &&
      this.maxWorkers < this.maxWorkersLimit &&
      this.queue.length > 0
    ) {
      const newWorkers = this.maxWorkers + 1;
      this.setMaxWorkers(newWorkers);
      this.log.debug(
        `CPU usage low (${smoothedCpuUsage.toFixed(0)}% avg, target: ${TARGET_CPU_USAGE}%), increasing workers to ${newWorkers}`,
      );
    }
    // If CPU is overloaded (> 98%), reduce workers to prevent system overload
    else if (
      smoothedCpuUsage > TARGET_CPU_USAGE + CPU_TOLERANCE &&
      this.maxWorkers > this.minWorkers
    ) {
      const newWorkers = this.maxWorkers - 1;
      this.setMaxWorkers(newWorkers);
      this.log.debug(
        `CPU usage high (${smoothedCpuUsage.toFixed(0)}% avg, target: ${TARGET_CPU_USAGE}%), reducing workers to ${newWorkers}`,
      );
    }
  }

  private startCpuMonitoring(): void {
    // Sample CPU every 1 second for smoother rolling average
    // Adjust workers every 3 seconds for more responsive scaling
    let sampleCount = 0;
    this.cpuMonitorInterval = setInterval(() => {
      if (this.completed < this.total && !this.maxFailuresReached && !this.cancelled) {
        // Sample CPU usage every second
        this.sampleCpuUsage();
        sampleCount++;

        // Adjust workers every 3 seconds (after we have enough samples)
        // More frequent adjustments allow for gentler scaling
        if (sampleCount >= 3) {
          this.adjustWorkersBasedOnCpu();
          sampleCount = 0;
        }
      }
    }, 500);
  }

  private stopCpuMonitoring(): void {
    if (this.cpuMonitorInterval) {
      clearInterval(this.cpuMonitorInterval);
      this.cpuMonitorInterval = undefined;
    }
  }

  private trackPerformance(): void {
    const now = Date.now();
    this.performanceHistory.push({
      timestamp: now,
      completed: this.completed,
      workers: this.maxWorkers,
    });

    // Keep only last 2 minutes of history
    const twoMinutesAgo = now - 120000;
    this.performanceHistory = this.performanceHistory.filter(
      (entry) => entry.timestamp > twoMinutesAgo,
    );

    // Adjust workers after each test completion (once we have minimal data)
    if (this.completed >= 2 && !this.maxFailuresReached && !this.cancelled) {
      this.adaptiveAdjustWorkers();
    }
  }

  private calculateThroughput(windowStartSeconds: number, windowEndSeconds: number = 0): number {
    const now = Date.now();
    const windowStart = now - windowStartSeconds * 1000;
    const windowEnd = now - windowEndSeconds * 1000;
    const recent = this.performanceHistory.filter(
      (entry) => entry.timestamp >= windowStart && entry.timestamp <= windowEnd,
    );

    if (recent.length < 2) {
      return 0; // Not enough data
    }

    const first = recent[0];
    const last = recent[recent.length - 1];
    const timeDiff = (last.timestamp - first.timestamp) / 1000; // seconds
    const completedDiff = last.completed - first.completed;

    if (timeDiff <= 0) {
      return 0;
    }

    return (completedDiff / timeDiff) * 60; // tests per minute
  }

  private adaptiveAdjustWorkers(): void {
    // Need at least 2 data points to calculate throughput
    if (this.performanceHistory.length < 2) {
      // Early stage: if we have work and can add workers, do it
      if (
        this.completed >= 2 &&
        this.maxWorkers < this.maxWorkersLimit &&
        this.queue.length > 0 &&
        this.activeWorkers < this.maxWorkers
      ) {
        const newWorkers = this.maxWorkers + 1;
        this.setMaxWorkers(newWorkers);
        this.log.debug(`Early stage: increasing workers to ${newWorkers}`);
      }
      return;
    }

    // Calculate recent throughput (last 10 seconds) vs slightly older throughput (10-20 seconds ago)
    // Use shorter windows for more responsive adjustments
    const recentThroughput = this.calculateThroughput(10, 0);
    const olderThroughput = this.calculateThroughput(20, 10);

    // If we have meaningful throughput data, use it for adjustment
    if (recentThroughput > 0 && olderThroughput > 0) {
      const improvement = (recentThroughput - olderThroughput) / olderThroughput;

      // If throughput improved by more than 3%, try increasing workers (more aggressive)
      if (improvement > 0.03 && this.maxWorkers < this.maxWorkersLimit && this.queue.length > 0) {
        const newWorkers = this.maxWorkers + 1;
        this.setMaxWorkers(newWorkers);
        this.log.debug(
          `Throughput improved (${recentThroughput.toFixed(1)} vs ${olderThroughput.toFixed(1)} tests/min), increasing workers to ${newWorkers}`,
        );
        return;
      }
      // If throughput degraded by more than 5%, reduce workers (more responsive)
      else if (improvement < -0.05 && this.maxWorkers > this.minWorkers) {
        const newWorkers = this.maxWorkers - 1;
        this.setMaxWorkers(newWorkers);
        this.log.debug(
          `Throughput degraded (${recentThroughput.toFixed(1)} vs ${olderThroughput.toFixed(1)} tests/min), reducing workers to ${newWorkers}`,
        );
        return;
      }
    }

    // Fallback: if we have work queued and workers are idle, scale up
    if (
      this.queue.length > this.activeWorkers &&
      this.maxWorkers < this.maxWorkersLimit &&
      this.completed >= 3
    ) {
      // If queue is growing faster than we're processing, add workers
      const timeSinceStart = Date.now() - this.startTime;
      const avgTimePerTest = timeSinceStart / Math.max(this.completed, 1);
      const estimatedQueueTime = this.queue.length * avgTimePerTest;
      const currentWorkTime = this.activeWorkers * avgTimePerTest;

      // If queue would take longer than current workers can handle, add more
      if (estimatedQueueTime > currentWorkTime * 1.2) {
        const newWorkers = Math.min(this.maxWorkers + 1, this.maxWorkersLimit);
        this.setMaxWorkers(newWorkers);
        this.log.debug(
          `Queue pressure: ${this.queue.length} queued, ${this.activeWorkers} active, increasing workers to ${newWorkers}`,
        );
        return;
      }
    }

    // If we have very few active workers relative to max, and queue is empty, consider scaling down
    if (
      this.queue.length === 0 &&
      this.activeWorkers < this.maxWorkers * 0.5 &&
      this.maxWorkers > this.minWorkers &&
      this.completed >= 5
    ) {
      const newWorkers = this.maxWorkers - 1;
      this.setMaxWorkers(newWorkers);
      this.log.debug(
        `Queue empty, low activity (${this.activeWorkers}/${this.maxWorkers} active), reducing workers to ${newWorkers}`,
      );
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
        // Make the most common error more actionable by inlining the diff path
        coloredReason = errorDetails.diffPath
          ? `${chalk.blue('Visual regression failed')}: ${chalk.gray(`diff → ${errorDetails.diffPath}`)}`
          : chalk.blue(reason);
      } else if (reason === 'No baseline snapshot found') {
        coloredReason = chalk.cyan(reason);
      } else {
        coloredReason = chalk.red(reason); // Default to red for unknown errors
      }

      const detailLines = [`  ${coloredReason}`, `  ${chalk.gray(`URL: ${errorDetails.url}`)}`];

      if (errorDetails.expectedPath) {
        // Show the baseline snapshot path
        detailLines.push(`  ${chalk.gray(`Baseline: ${errorDetails.expectedPath}`)}`);
      }

      // Only add diff path to detail lines if it wasn't already included in the reason
      // (for "Visual differences detected", the diff path is already in coloredReason)
      if (errorDetails.diffPath && reason !== 'Visual differences detected') {
        // Keep a separate diff line as well for easy parsing/copying
        detailLines.push(`  ${chalk.gray(`Diff: ${errorDetails.diffPath}`)}`);
      } else if (!errorDetails.diffPath) {
        // Provide more context about why diff wasn't generated
        const reason = errorDetails.reason || '';
        if (/target crashed|page crashed|browser crashed/i.test(reason)) {
          detailLines.push(
            `  ${chalk.gray('Diff: not generated (browser crashed before screenshot could be captured)')}`,
          );
        } else {
          detailLines.push(`  ${chalk.gray('Diff: not generated')}`);
        }
      }

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
    this.trackPerformance();
    this.onProgress?.(this.completed, this.total, this.results);
  }

  async run(
    onProgress?: (completed: number, total: number, results: any) => void,
    onComplete?: (results: any) => void,
  ): Promise<{ success: boolean; failed: number }> {
    this.onProgress = onProgress;
    this.onComplete = onComplete;

    // Start CPU monitoring
    this.startCpuMonitoring();

    return new Promise((resolve) => {
      // Start initial workers with staggered launches
      for (let i = 0; i < Math.min(this.maxWorkers, this.queue.length); i++) {
        this.spawnWorker(true);
      }

      // Check for completion periodically
      const checkComplete = () => {
        // Check if maxFailures is reached and no workers are active
        if ((this.maxFailuresReached || this.cancelled) && this.activeWorkers === 0) {
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

    // Retry logic: attempt up to retries + 1 times (initial attempt + retries)
    const maxAttempts = (this.config.retries || 0) + 1;
    this.log.debug(
      `Story ${story.id}: Retry configuration - retries: ${this.config.retries || 0}, maxAttempts: ${maxAttempts}`,
    );
    let lastError: Error | null = null;
    let result: string | null = null;
    let page: Page | undefined; // Store page reference for DOM dumping on timeout
    let displayViewport = storyViewport; // Will be updated with actual viewport if available
    let displayViewportName: string | undefined; // Will be updated with viewport name if available

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Small staggered delay to stagger browser launches and reduce resource contention
        // Only apply staggering to the initial batch of workers
        if (attempt === 1 && staggerLaunch) {
          // Use a simple hash of story ID to create consistent, staggered delays
          let hash = 0;
          for (let i = 0; i < story.id.length; i++) {
            hash = ((hash << 5) - hash + story.id.charCodeAt(i)) & 0xffffffff;
          }
          const delay = Math.abs(hash) % 50; // 0-49ms staggered delay based on story ID
          this.log.debug(
            `Story ${story.id}: Staggering browser launch (delay: ${delay.toFixed(1)}ms)`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // Add a small delay between retries
          this.log.debug(`Story ${story.id}: Waiting before retry attempt ${attempt}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Check if max failures reached before starting retry attempt
        if (this.maxFailuresReached || this.cancelled) {
          this.log.debug(`Story ${story.id}: Test cancelled before retry attempt ${attempt}`);
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
        const attemptDuration = Date.now() - attemptStart;
        this.log.debug(`Story ${story.id}: Attempt ${attempt} succeeded in ${attemptDuration}ms`);
        lastError = null;
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error as Error;

        // Check if this is a cancellation error - don't retry these
        const isCancelled = String(lastError).includes('Test cancelled');
        if (isCancelled) {
          this.log.debug(`Story ${story.id}: Test cancelled, not retrying`);
          break; // Exit retry loop
        }

        // Dump DOM if timeout or crash occurred (on any attempt, not just last)
        const isTimeout =
          lastError && /timeout|Timed out|Operation timed out/i.test(String(lastError));
        const isCrash =
          lastError && /Target crashed|crashed|Protocol error/i.test(String(lastError));
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

        if (attempt < maxAttempts) {
          // Will retry, log if debug mode
          this.log.debug(
            `Story ${story.id}: Attempt ${attempt}/${maxAttempts} failed, retrying...`,
          );
          if (lastError) {
            this.log.debug(`  Error: ${String(lastError)}`);
          }
        }
        // If this is the last attempt, error will be handled below
      }
    }

    const duration = Date.now() - startTime;
    this.log.debug(
      `Story ${story.id}: Test completed in ${duration}ms with result: ${result || 'failed'}`,
    );

    if (result !== null) {
      // Success
      this.results[story.id] = { success: true, duration, action: result };

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
          if (!diffPath && /timeout/i.test(errorStr)) {
            try {
              const expected = path.join(this.config.snapshotPath, story.snapshotRelPath);
              const actual = path.join(
                path.dirname(path.join(this.config.resultsPath, story.snapshotRelPath)),
                path.basename(story.snapshotRelPath),
              );
              if (fs.existsSync(actual) && fs.existsSync(expected)) {
                // Generate diff for timeout cases to show what was captured
                const timeoutDiffPath = path.join(
                  path.dirname(actual),
                  `${path.basename(actual, path.extname(actual))}.diff.png`,
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
            } else if (/timeout/i.test(errorStr)) {
              // Check if crash occurred during timeout
              const actual = path.join(
                path.dirname(path.join(this.config.resultsPath, story.snapshotRelPath)),
                path.basename(story.snapshotRelPath),
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
          const expected = path.join(this.config.snapshotPath, story.snapshotRelPath);
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
    this.trackPerformance();
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

  private async executeSingleTestAttempt(
    story: DiscoveredStory,
    viewport?: { width: number; height: number },
  ): Promise<{
    result: string;
    page?: Page;
    actualViewport?: { width: number; height: number };
    viewportName?: string;
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

      await page.waitForSelector('body.sb-show-main');
      await page.waitForSelector('#storybook-root');

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
            if (typeof (window as any).__STORYBOOK_ADDONS_CHANNEL__ !== 'undefined') {
              const channel = (window as any).__STORYBOOK_ADDONS_CHANNEL__;
              const data = channel.data || {};

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

      // // Wait for DOM to stabilize: configurable quiet period after last mutation, with max wait timeout
      // const quietPeriodMs: number = Number(this.config.domStabilityQuietPeriod ?? 300); // Default: 300ms after last mutation
      // const maxWaitMs: number = Number(this.config.domStabilityMaxWait ?? 2000); // Default: 2000ms total wait

      // const isStable = await page.evaluate(
      //   ({ quietPeriodMs, maxWaitMs }) => {
      //     return new Promise<boolean>((resolve) => {
      //       // Use performance.now() for timing to avoid issues with mocked Date.now()
      //       const start = performance.now();
      //       let lastMutation = performance.now();

      //       const obs = new MutationObserver(() => {
      //         lastMutation = performance.now();
      //       });

      //       obs.observe(document.body, {
      //         childList: true,
      //         subtree: true,
      //         attributes: true,
      //         characterData: true,
      //       });

      //       const checkStability = () => {
      //         const now = performance.now();
      //         const timeSinceLastMutation = now - lastMutation;
      //         const totalTime = now - start;

      //         if (timeSinceLastMutation >= quietPeriodMs) {
      //           // DOM has been stable for quietPeriodMs
      //           obs.disconnect();
      //           resolve(true);
      //         } else if (totalTime >= maxWaitMs) {
      //           // We've waited long enough, proceed anyway
      //           obs.disconnect();
      //           resolve(false);
      //         } else {
      //           // Keep checking
      //           setTimeout(checkStability, 10);
      //         }
      //       };

      //       checkStability();
      //     });
      //   },
      //   { quietPeriodMs, maxWaitMs },
      // );

      // if (!isStable) {
      //   this.log.debug(
      //     `Story ${story.id}: DOM still mutating after ${maxWaitMs}ms, taking screenshot anyway`,
      //   );
      // } else {
      //   this.log.debug(`Story ${story.id}: DOM is stable`);
      // }

      // Check for cancellation before screenshot
      if (this.cancelled || this.maxFailuresReached) {
        this.log.debug(`Story ${story.id}: Test cancelled before screenshot, cleaning up`);
        await browser.close();
        throw new Error('Test cancelled');
      }

      // Optimized screenshot capture
      const expected = path.join(this.config.snapshotPath, story.snapshotRelPath);

      // In update mode, capture directly to expected location to avoid writing to results
      const actual = this.config.update
        ? expected
        : path.join(
            path.dirname(path.join(this.config.resultsPath, story.snapshotRelPath)),
            path.basename(story.snapshotRelPath),
          );

      this.log.debug(
        `Story ${story.id}: Screenshot paths - expected: ${expected}, actual: ${actual}`,
      );

      // Pre-create directory to avoid contention
      // Use the exact same path calculation as the file path to ensure consistency
      // Create directory with retry logic to handle race conditions
      const ensureDirectoryExists = (dirPath: string, retries = 3): void => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            // Check if directory already exists
            if (fs.existsSync(dirPath)) {
              // Verify it's actually a directory and writable
              const stats = fs.statSync(dirPath);
              if (!stats.isDirectory()) {
                throw new Error(`Path exists but is not a directory: ${dirPath}`);
              }
              // Check write permissions
              fs.accessSync(dirPath, fs.constants.W_OK);
              return; // Directory exists and is writable
            }

            // Directory doesn't exist, create it recursively
            this.log.debug(
              `Story ${story.id}: Creating directory (attempt ${attempt}/${retries}): ${dirPath}`,
            );
            fs.mkdirSync(dirPath, { recursive: true });

            // Verify it was created
            if (!fs.existsSync(dirPath)) {
              throw new Error(
                `Directory creation reported success but directory doesn't exist: ${dirPath}`,
              );
            }

            // Verify it's writable
            fs.accessSync(dirPath, fs.constants.W_OK);
            this.log.debug(`Story ${story.id}: Directory created and verified: ${dirPath}`);
            return;
          } catch (error) {
            const errorMsg = String(error);
            // If it's the last attempt, throw the error
            if (attempt === retries) {
              throw new Error(
                `Failed to create directory after ${retries} attempts: ${dirPath}. Error: ${errorMsg}`,
              );
            }
            // Otherwise, wait a bit and retry (helps with race conditions)
            this.log.debug(
              `Story ${story.id}: Directory creation attempt ${attempt} failed, retrying... Error: ${errorMsg}`,
            );
            // Small delay to allow other processes to finish
            const delay = attempt * 10; // 10ms, 20ms, 30ms delays
            const start = Date.now();
            while (Date.now() - start < delay) {
              // Busy wait for precise timing
            }
          }
        }
      };

      try {
        const targetDir = path.dirname(actual);
        // Ensure base results directory exists first
        if (!fs.existsSync(this.config.resultsPath)) {
          this.log.debug(
            `Story ${story.id}: Creating base results directory: ${this.config.resultsPath}`,
          );
          fs.mkdirSync(this.config.resultsPath, { recursive: true });
        }
        // Then ensure the target directory exists
        ensureDirectoryExists(targetDir);
      } catch (dirError) {
        const errorMsg = `Failed to create directory for screenshot: ${dirError}`;
        this.log.error(`Story ${story.id}: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Date is already fixed via context.addInitScript, no need for clock API

      // Verify page is still open before attempting screenshot
      if (page.isClosed()) {
        const errorMsg = `Page was closed before screenshot could be captured`;
        this.log.error(`Story ${story.id}: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Final verification right before screenshot (safety check for race conditions)
      const targetDir = path.dirname(actual);
      if (!fs.existsSync(targetDir)) {
        this.log.warn(
          `Story ${story.id}: Directory missing immediately before screenshot, recreating: ${targetDir}`,
        );
        try {
          ensureDirectoryExists(targetDir, 2); // Quick retry with fewer attempts
        } catch (recreateError) {
          const errorMsg = `Directory does not exist and could not be created: ${targetDir}. Error: ${recreateError}`;
          this.log.error(`Story ${story.id}: ${errorMsg}`);
          throw new Error(errorMsg);
        }
      }

      // Capture screenshot with settings optimized for visual regression
      this.log.debug(
        `Story ${story.id}: Capturing screenshot${this.config.fullPage ? ' (full page)' : ''}...`,
      );
      const screenshotStart = Date.now();
      try {
        await page.screenshot({
          path: actual,
          fullPage: this.config.fullPage,
          type: 'png', // PNG format required for accurate odiff comparison
        });
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

        // Check for ENOENT errors - verify directory still exists and provide detailed diagnostics
        if (/ENOENT|no such file/i.test(errorMsg)) {
          const targetDir = path.dirname(actual);
          const dirExists = fs.existsSync(targetDir);
          const dirIsWritable = dirExists
            ? (() => {
                try {
                  fs.accessSync(targetDir, fs.constants.W_OK);
                  return true;
                } catch {
                  return false;
                }
              })()
            : false;

          const diagnosticInfo = [
            `Target directory: ${targetDir}`,
            `Directory exists: ${dirExists}`,
            `Directory writable: ${dirIsWritable}`,
            `Target file: ${actual}`,
            `Parent directory exists: ${fs.existsSync(path.dirname(targetDir))}`,
          ].join(', ');

          this.log.error(`Story ${story.id}: ENOENT diagnostic - ${diagnosticInfo}`);

          // Try to recreate directory one more time
          if (!dirExists) {
            try {
              this.log.warn(`Story ${story.id}: Attempting to recreate directory: ${targetDir}`);
              fs.mkdirSync(targetDir, { recursive: true });
              if (fs.existsSync(targetDir)) {
                this.log.info(`Story ${story.id}: Directory recreated successfully`);
                // Don't throw - let the error propagate with context
              }
            } catch (recreateError) {
              this.log.error(`Story ${story.id}: Failed to recreate directory: ${recreateError}`);
            }
          }

          throw new Error(
            `Screenshot capture failed: file system error - directory may not exist or is not writable. ${errorDetails}. Diagnostic: ${diagnosticInfo}`,
          );
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

      // Verify screenshot file was actually created
      if (!fs.existsSync(actual)) {
        const errorMsg = `Screenshot file was not created at ${actual}. Screenshot capture may have failed silently.`;
        this.log.error(`Story ${story.id}: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Handle baseline logic with odiff visual regression testing
      const missingBaseline = !fs.existsSync(expected);
      let result: string;

      this.log.debug(
        `Story ${story.id}: Baseline check - expected: ${expected}, missing: ${missingBaseline}, update mode: ${this.config.update}`,
      );

      if (this.config.update) {
        // In update mode, screenshot is already captured directly to expected location
        result = missingBaseline ? 'Created baseline' : 'Updated baseline';
        this.log.debug(`Story ${story.id}: ${result}`);
      } else if (missingBaseline) {
        this.log.debug(`Story ${story.id}: Missing baseline, skipping test`);
        // Check if actual screenshot was captured successfully
        if (fs.existsSync(actual)) {
          this.log.warn(
            `Story ${story.id}: Baseline missing but screenshot captured. Consider running with --update to create baseline.`,
          );
        }
        throw new Error(`Missing baseline: ${expected}`);
      } else {
        // Perform visual regression test using odiff
        const diffPath = path.join(
          path.dirname(actual),
          `${path.basename(actual, path.extname(actual))}.diff.png`,
        );

        try {
          // Verify both files exist before comparison
          if (!fs.existsSync(actual)) {
            throw new Error(`Screenshot file does not exist: ${actual}`);
          }
          if (!fs.existsSync(expected)) {
            throw new Error(`Baseline file does not exist: ${expected}`);
          }

          // Run odiff comparison using Node.js bindings
          // Wrap in a timeout to prevent hanging in CI environments
          const compareStart = Date.now();
          const odiffTimeout = 30000; // 30 second timeout for odiff comparison
          this.log.debug(
            `Story ${story.id}: Comparing images with odiff (threshold: ${this.config.threshold}, timeout: ${odiffTimeout}ms)`,
          );

          const odiffResult = await Promise.race([
            odiffCompare(expected, actual, diffPath, {
              threshold: this.config.threshold,
              outputDiffMask: true,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`odiff comparison timed out after ${odiffTimeout}ms`)),
                odiffTimeout,
              ),
            ),
          ]);

          this.log.debug(
            `Story ${story.id}: odiff comparison completed in ${Date.now() - compareStart}ms, match: ${odiffResult.match}`,
          );

          if (odiffResult.match) {
            // Images are identical within threshold
            result = 'Visual regression passed';
            this.log.debug(`Story ${story.id}: Visual regression test passed`);

            // Clean up diff file if it exists (odiff may create it)
            if (fs.existsSync(diffPath)) {
              try {
                fs.unlinkSync(diffPath);
              } catch {}
            }

            // Delete the actual screenshot since it matches the baseline
            if (fs.existsSync(actual)) {
              try {
                fs.unlinkSync(actual);
                this.log.debug(`Story ${story.id}: Deleted actual screenshot (matches baseline)`);

                // Don't remove empty directories during parallel execution to avoid race conditions
                // where another worker might be trying to create a screenshot in the same directory
                // Directory cleanup will happen at the end if needed
                // const actualDir = path.dirname(actual);
                // removeEmptyDirectories(actualDir, this.config.resultsPath);
              } catch (error) {
                this.log.debug(`Story ${story.id}: Failed to delete actual screenshot: ${error}`);
              }
            }
          } else {
            // Images differ beyond threshold
            this.log.debug(`Story ${story.id}: Images differ - reason: ${odiffResult.reason}`);
            this.log.debug(`Story ${story.id}: Diff image saved to: ${diffPath}`);
            throw new Error(`Visual regression failed: images differ (diff: ${diffPath})`);
          }
        } catch (error: any) {
          // odiff comparison failed
          if (error?.message && error.message.includes('images differ')) {
            throw error; // Re-throw our own error
          }

          // Check for missing baseline file error
          const errMsg = error?.message || String(error);
          if (errMsg.includes('Could not load base image')) {
            // Verify if baseline file exists
            if (!fs.existsSync(expected)) {
              this.log.error(
                `Story ${story.id}: Baseline file does not exist: ${expected}. Consider running with --update to create baseline.`,
              );
              throw new Error(`Missing baseline: ${expected}`);
            } else {
              // File exists but odiff can't load it - might be corrupted
              this.log.error(
                `Story ${story.id}: Baseline file exists but cannot be loaded (possibly corrupted): ${expected}`,
              );
              throw new Error(`Could not load base image: ${expected}`);
            }
          }

          // Emit full diagnostic details to help identify the exact failure cause
          const diagLines: string[] = [];
          diagLines.push(`odiff error: ${errMsg}`);
          if (typeof error?.code !== 'undefined') diagLines.push(`code: ${error.code}`);
          if (typeof error?.exitCode !== 'undefined') diagLines.push(`exitCode: ${error.exitCode}`);
          if (error?.stderr) diagLines.push(`stderr: ${String(error.stderr).trim()}`);
          if (error?.stdout) diagLines.push(`stdout: ${String(error.stdout).trim()}`);
          if (error?.stack) diagLines.push(`stack: ${String(error.stack).trim()}`);
          if (error?.cause) {
            const causeMsg =
              typeof error.cause === 'object'
                ? error.cause?.message || String(error.cause)
                : String(error.cause);
            diagLines.push(`cause: ${causeMsg}`);
          }
          this.log.error(`Story ${story.id}: odiff failed\n  ${diagLines.join('\n  ')}`);

          throw new Error(`odiff comparison failed: ${errMsg}`);
        }
      }

      return { result, page, actualViewport, viewportName };
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
}): Promise<number> {
  const { stories, config, debug, callbacks } = options;
  // Initialize global logger
  setGlobalLogger(config.logLevel);
  const log = createLogger(config.logLevel);

  log.debug(`Starting parallel test run with ${stories.length} stories`);
  log.debug(
    `Configuration: workers=${config.workers || 'default'}, retries=${config.retries ?? 0}, maxFailures=${config.maxFailures ?? 'unlimited'}, threshold=${config.threshold}, update=${config.update}`,
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

  // If workers are explicitly configured, use that value
  // Otherwise, start with 1 worker and let it scale up dynamically based on CPU usage
  const cpuCount = os.cpus().length;
  let numWorkers: number;
  let maxWorkersLimit: number;
  if (config.workers !== undefined && config.workers !== null) {
    numWorkers = config.workers;
    maxWorkersLimit = numWorkers; // Use configured value as both initial and max
    log.debug(`Using explicitly configured worker count: ${numWorkers}`);
  } else {
    // Start with 1 worker - will scale up dynamically based on CPU usage
    numWorkers = 0; // Pass 0 to WorkerPool constructor to indicate dynamic scaling
    maxWorkersLimit = cpuCount * 2; // Allow scaling up to 2x CPU cores
    log.debug('Starting with 1 worker, will scale up dynamically based on CPU usage');
  }
  log.debug(
    `Worker pool: ${numWorkers === 0 ? '1 (will scale dynamically)' : numWorkers} workers (${cpuCount} CPU cores, max: ${maxWorkersLimit})`,
  );

  // In test mode, filter out stories that don't have snapshots
  let filteredStories = stories;
  if (!config.update) {
    filteredStories = stories.filter((story) => {
      const snapshotPath = path.join(config.snapshotPath, story.snapshotRelPath);
      const hasSnapshot = fs.existsSync(snapshotPath);
      if (!hasSnapshot) {
        log.debug(`Skipping story ${story.id}: no baseline snapshot exists`);
      }
      return hasSnapshot;
    });

    const skippedCount = stories.length - filteredStories.length;
    if (skippedCount > 0) {
      log.info(
        `Skipped ${skippedCount} stories with no baseline snapshots (use --update to create them)`,
      );
    }
  }

  const mode = config.update ? 'updating snapshots' : 'testing';
  const storyCount = filteredStories.length;
  const workerDisplay = numWorkers === 0 ? '1 (scaling dynamically)' : String(numWorkers);
  const initialMessage = `Running ${chalk.yellow(String(storyCount))} stories using ${chalk.yellow(workerDisplay)} concurrent workers (${chalk.cyan(mode)})...`;
  if (!config.quiet) {
    log.info(initialMessage);
  }

  // Log fixDate configuration once before tests start
  if (config.fixDate) {
    const fixedDate = parseFixDate(config.fixDate);
    log.info(
      `Date fixing enabled - config value: ${JSON.stringify(config.fixDate)}, fixed date: ${fixedDate.toISOString()}`,
    );
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
    maxWorkersLimit,
    config,
    filteredStories,
    printUnderSpinner,
    callbacks,
  );

  // Track current worker count for status display
  // Initialize from pool's actual worker count (starts at 1 for dynamic scaling)
  let currentWorkers = pool.getMaxWorkers();
  pool.setWorkersChangedCallback((workers: number) => {
    currentWorkers = workers;
  });

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

    // Get CPU usage from the pool (updated every 5 seconds)
    const cpuUsagePercent = pool.getCurrentCpuUsage();

    // Use smoothed time remaining
    const timeStr = formatTimeRemaining(smoothedTimeRemaining);

    // Build status line components
    const statusParts: (string | null)[] = [
      chalk.yellow(`Stories: ${completed}/${total}`),
      chalk.cyan(`Completed: ${percent}%`),
      chalk.cyan(`Time: ~${timeStr}`),
      chalk.magenta(`Stories/m: ${storiesPerMinute}`),
      chalk.blue(`Workers: ${currentWorkers}`),
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
