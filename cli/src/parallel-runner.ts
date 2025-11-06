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
      if (skipped > 0) {
        breakdown.push(`Skipped: ${skipped}`);
      }
      breakdown.push(`storiesPerMinute: ${testsPerMinute}`);
    } else {
      breakdown.push(`Passed: ${passed}`);
      breakdown.push(`Failed: ${failed}`);
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
  private maxWorkers: number;
  private results: {
    [storyId: string]: { success: boolean; error?: string; duration: number; action?: string };
  } = {};
  private startTime = Date.now();
  private completed = 0;
  private total: number;
  private config: TestConfig;
  private onProgress?: (completed: number, total: number, results: any) => void;
  private onComplete?: (results: any) => void;
  private singleLineMode: boolean;
  private printUnderSpinner?: (line: string) => void;
  private callbacks?: RunCallbacks;
  private log: ReturnType<typeof createLogger>;
  private maxFailuresReached = false;

  constructor(
    maxWorkers: number,
    config: TestConfig,
    stories: DiscoveredStory[],
    printUnderSpinner?: (line: string) => void,
    callbacks?: RunCallbacks,
  ) {
    this.maxWorkers = maxWorkers;
    this.config = config;
    this.total = stories.length;
    this.queue = [...stories];
    this.callbacks = callbacks;
    this.singleLineMode = Boolean(config.summary || config.showProgress);
    this.printUnderSpinner = printUnderSpinner;
    this.log = createLogger(config.logLevel);
  }

  // Unified method for printing story results
  private printStoryResult(
    story: DiscoveredStory,
    displayName: string,
    result: 'success' | 'skipped' | 'failed',
    duration: number,
    errorDetails?: { reason: string; url: string; diffPath?: string },
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
      if (secs < 2) {
        return `${chalk.green(secsStr)}${unit}`;
      } else if (secs < 4) {
        return `${chalk.yellow(secsStr)}${unit}`;
      } else {
        return `${chalk.red(secsStr)}${unit}`;
      }
    };

    // Build the result line
    let line: string;
    let logLevel: 'info' | 'error' = 'info';

    switch (result) {
      case 'success':
        line = `${chalk.green('✓')} ${displayName} ${colorDuration(duration)}`;
        break;
      case 'skipped':
        line = `${chalk.yellow('○')} ${displayName} ${colorDuration(duration)} ${chalk.dim('(no snapshot)')}`;
        break;
      case 'failed':
        line = `${chalk.red('✗')} ${displayName} ${colorDuration(duration)}`;
        logLevel = 'error';
        break;
    }

    // Print the main result line
    if (this.printUnderSpinner) {
      this.printUnderSpinner(line);
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

      if (errorDetails.diffPath) {
        // Keep a separate diff line as well for easy parsing/copying
        detailLines.push(`  ${chalk.gray(`Diff: ${errorDetails.diffPath}`)}`);
      } else {
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
          this.printUnderSpinner(detailLine);
        } else {
          this.log.error(detailLine);
        }
      }
    }
  }

  getResults() {
    return this.results;
  }

  async run(
    onProgress?: (completed: number, total: number, results: any) => void,
    onComplete?: (results: any) => void,
  ): Promise<{ success: boolean; failed: number }> {
    this.onProgress = onProgress;
    this.onComplete = onComplete;

    return new Promise((resolve) => {
      // Start initial workers
      for (let i = 0; i < Math.min(this.maxWorkers, this.queue.length); i++) {
        this.spawnWorker();
      }

      // Check for completion periodically
      const checkComplete = () => {
        // Check if maxFailures is reached and no workers are active
        if (this.maxFailuresReached && this.activeWorkers === 0) {
          const failed = Object.values(this.results).filter((r) => !r.success).length;
          const success = failed === 0;
          this.onComplete?.(this.results);
          resolve({ success, failed });
          return;
        }

        if (this.completed >= this.total) {
          const failed = Object.values(this.results).filter((r) => !r.success).length;
          const success = failed === 0;
          this.onComplete?.(this.results);
          resolve({ success, failed });
        } else {
          setTimeout(checkComplete, 100); // Check every 100ms
        }
      };
      checkComplete();
    });
  }

  private spawnWorker() {
    // Continuously spawn workers until we reach capacity or run out of work
    // Stop spawning if maxFailures is reached
    while (
      this.queue.length > 0 &&
      this.activeWorkers < this.maxWorkers &&
      !this.maxFailuresReached
    ) {
      this.activeWorkers++;
      const story = this.queue.shift()!;

      this.runStoryTest(story).finally(() => {
        this.activeWorkers--;
        // After completion, check if we need to spawn more workers
        // Use setImmediate to avoid deep recursion
        setImmediate(() => this.spawnWorker());
      });
    }
  }

  private async runStoryTest(story: DiscoveredStory): Promise<void> {
    const startTime = Date.now();
    this.log.debug(`Starting test for story: ${story.id} (${story.title}/${story.name})`);

    // Notify callbacks that story has started
    this.callbacks?.onStoryStart?.(story.id, `${story.title}/${story.name}`);

    // Helper to return file paths as-is
    const escapePath = (filePath: string): string => {
      return filePath;
    };

    // Compute a human-friendly display name using title/name from story ID, maintaining path structure
    const toDisplayName = (): string => {
      // Use title as the directory path and name as the basename
      // This is closer to the story ID structure (title--name) while keeping path splitting
      return story.title ? `${story.title}/${story.name}` : story.name;
    };
    const displayName = toDisplayName();

    // Retry logic: attempt up to retries + 1 times (initial attempt + retries)
    const maxAttempts = (this.config.retries || 0) + 1;
    let lastError: Error | null = null;
    let result: string | null = null;
    let page: Page | undefined; // Store page reference for DOM dumping on timeout

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Small random delay to stagger browser launches and reduce resource contention
        if (attempt === 1) {
          const delay = Math.random() * 50; // 0-50ms random delay only on first attempt
          this.log.debug(
            `Story ${story.id}: Staggering browser launch (delay: ${delay.toFixed(1)}ms)`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // Add a small delay between retries
          this.log.debug(`Story ${story.id}: Waiting before retry attempt ${attempt}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const attemptStart = Date.now();
        const testResult = await this.executeSingleTestAttempt(story);
        result = testResult.result;
        page = testResult.page; // Store page reference for potential DOM dump
        const attemptDuration = Date.now() - attemptStart;
        this.log.debug(`Story ${story.id}: Attempt ${attempt} succeeded in ${attemptDuration}ms`);
        lastError = null;
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error as Error;

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
      this.printStoryResult(story, displayName, 'success', duration);
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
        this.printStoryResult(story, displayName, 'skipped', duration);
      } else {
        // Failed after all retries
        this.results[story.id] = {
          success: false,
          error: lastError ? String(lastError) : 'Unknown error',
          duration,
          action: 'failed',
        };

        // Check if maxFailures is reached
        const failedCount = Object.values(this.results).filter((r) => r.action === 'failed').length;
        if (this.config.maxFailures && failedCount >= this.config.maxFailures) {
          this.maxFailuresReached = true;
          this.log.warn(
            `Max failures (${this.config.maxFailures}) reached. Stopping test execution.`,
          );
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
                  this.log.debug(`Story ${story.id}: Generated diff for timeout case: ${diffPath}`);
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
            errorReason = 'Failed to capture screenshot';
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
        this.printStoryResult(story, displayName, 'failed', duration, {
          reason: errorReason,
          url: displayUrl,
          diffPath: printDiffPath,
        });
      }
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

  private async executeSingleTestAttempt(
    story: DiscoveredStory,
  ): Promise<{ result: string; page?: Page }> {
    let browser: Browser | undefined;
    let page: Page | undefined;

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

      const viewport = this.config.perStory?.[story.id]?.viewport;
      this.log.debug(
        `Story ${story.id}: Creating browser context${viewport ? ` with viewport: ${JSON.stringify(viewport)}` : ''}...`,
      );
      // Configure context with proxy settings if available (for CI environments)
      const contextOptions: Parameters<typeof browser.newContext>[0] = {
        viewport: typeof viewport === 'object' ? viewport : undefined,
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

      // Wait for Storybook root to be attached
      this.log.debug(`Story ${story.id}: Waiting for #storybook-root...`);
      await page.waitForSelector('#storybook-root', { state: 'attached', timeout: pageTimeout });
      this.log.debug(`Story ${story.id}: Storybook root found`);

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

      // Quick check: Is content already ready? (stories may load instantly)
      // Add a small delay to allow initial render to complete
      await page.waitForTimeout(100);

      let contentReady = false;
      if (!page.isClosed()) {
        try {
          const hasContent = await page.evaluate(() => {
            try {
              const root = document.getElementById('storybook-root');
              if (!root) return false;

              // Check multiple indicators of content:
              // 1. Has children elements
              // 2. Has innerHTML content
              // 3. Has text content
              // 4. Has visual dimensions (rendered content)
              // 5. Has canvas/SVG elements (for graphics-heavy stories)
              const hasChildren = root.children.length > 0;
              const hasHTML = root.innerHTML.trim().length > 0;
              const hasText = !!(root.textContent && root.textContent.trim().length > 0);
              const hasDimensions = root.offsetHeight > 0 && root.offsetWidth > 0;
              const hasGraphics = !!root.querySelector('canvas, svg');

              return hasChildren || hasHTML || (hasText && hasDimensions) || hasGraphics;
            } catch {
              return false;
            }
          });
          if (hasContent) {
            contentReady = true;
            this.log.debug(
              `Story ${story.id}: Content already ready (checked immediately after root found)`,
            );
          }
        } catch (e: any) {
          if (/target crashed|page crashed/i.test(String(e))) {
            this.log.debug(`Story ${story.id}: Page crashed during immediate content check`);
            throw e;
          }
          // Continue to wait if check fails
        }
      }

      // Wait for story content to actually load - Storybook specific waiting
      // Use fast waitForFunction first, then fall back to polling if needed
      // Respect testTimeout from config - if stories take longer than configured, fail fast
      const contentWaitTimeout = pageTimeout;
      const startTime = Date.now();

      // Only wait if content isn't already ready from immediate check
      if (!contentReady) {
        this.log.debug(
          `Story ${story.id}: Waiting for story content (timeout: ${contentWaitTimeout}ms)...`,
        );

        try {
          // First try: Use waitForFunction for fast path (optimized by Playwright)
          // Use 80% of timeout for fast path, leaving 20% for polling fallback
          const fastPathTimeout = Math.floor(contentWaitTimeout * 0.8);
          try {
            await page.waitForFunction(
              () => {
                try {
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
                } catch {
                  return false;
                }
              },
              { timeout: fastPathTimeout },
            );
            contentReady = true;
            this.log.debug(`Story ${story.id}: Story content loaded (fast path)`);
          } catch (fastPathError: any) {
            // Fast path failed - check if page crashed or just timed out
            if (/target crashed|page crashed/i.test(String(fastPathError))) {
              this.log.debug(`Story ${story.id}: Page crashed during fast path check`);
              throw fastPathError;
            }

            // Fast path timed out, but we still have time - fall back to polling
            const remainingTime = contentWaitTimeout - (Date.now() - startTime);
            if (remainingTime > 0) {
              this.log.debug(
                `Story ${story.id}: Fast path timed out, falling back to polling (${remainingTime}ms remaining)...`,
              );

              // Fallback: Manual polling with shorter intervals
              const pollInterval = 200; // Check every 200ms
              const pollStartTime = Date.now();

              while (Date.now() - pollStartTime < remainingTime) {
                if (page.isClosed()) {
                  throw new Error('Page closed during content polling');
                }

                try {
                  const hasContent = await page.evaluate(() => {
                    try {
                      const root = document.getElementById('storybook-root');
                      if (!root) return false;

                      // Check multiple indicators of content
                      const hasChildren = root.children.length > 0;
                      const hasHTML = root.innerHTML.trim().length > 0;
                      const hasText = !!(root.textContent && root.textContent.trim().length > 0);
                      const hasDimensions = root.offsetHeight > 0 && root.offsetWidth > 0;
                      const hasGraphics = !!root.querySelector('canvas, svg');

                      return hasChildren || hasHTML || (hasText && hasDimensions) || hasGraphics;
                    } catch {
                      return false;
                    }
                  });

                  if (hasContent) {
                    contentReady = true;
                    this.log.debug(`Story ${story.id}: Story content loaded (polling fallback)`);
                    break;
                  }
                } catch (evalError: any) {
                  // If evaluation fails, page might be crashing
                  if (/target crashed|page crashed/i.test(String(evalError))) {
                    this.log.debug(`Story ${story.id}: Page crashed during polling fallback`);
                    throw evalError;
                  }
                  // Other evaluation errors - continue polling
                }

                // Wait before next poll
                await new Promise((resolve) => setTimeout(resolve, pollInterval));
              }
            }

            if (!contentReady) {
              throw new Error(`Timeout waiting for story content after ${contentWaitTimeout}ms`);
            }
          }
        } catch (e: any) {
          // Log what we found for debugging
          // Use try-catch around page.evaluate in case the page crashed
          let contentInfo: {
            exists: boolean;
            hasText?: boolean;
            childrenCount?: number;
            hasCanvas?: boolean;
            innerHTMLLength?: number;
            innerHTML?: string;
            error?: string;
          } = { exists: false, error: 'Failed to evaluate' };

          try {
            if (!page.isClosed()) {
              contentInfo = await page.evaluate(() => {
                try {
                  const root = document.getElementById('storybook-root');
                  if (!root) return { exists: false };

                  // Use the same comprehensive check as the content detection
                  const hasChildren = root.children.length > 0;
                  const hasHTML = root.innerHTML.trim().length > 0;
                  const hasText = !!(root.textContent && root.textContent.trim().length > 0);
                  const hasDimensions = root.offsetHeight > 0 && root.offsetWidth > 0;
                  const hasGraphics = !!root.querySelector('canvas, svg');
                  const hasContent =
                    hasChildren || hasHTML || (hasText && hasDimensions) || hasGraphics;

                  return {
                    exists: true,
                    hasContent,
                    hasText,
                    hasDimensions,
                    hasGraphics,
                    childrenCount: root.children.length,
                    hasCanvas: !!root.querySelector('canvas'),
                    innerHTMLLength: root.innerHTML.trim().length,
                    offsetHeight: root.offsetHeight,
                    offsetWidth: root.offsetWidth,
                    innerHTML: root.innerHTML.substring(0, 200), // First 200 chars for debugging
                  };
                } catch (evalErr) {
                  return { exists: false, error: `Evaluation error: ${String(evalErr)}` };
                }
              });
            } else {
              contentInfo = { exists: false, error: 'Page is closed' };
            }
          } catch (evalError: any) {
            contentInfo = {
              exists: false,
              error: `Evaluation failed: ${String(evalError)}`,
            };
          }
          this.log.debug(
            `Story ${story.id}: Content check failed. Root state: ${JSON.stringify(contentInfo)}`,
          );
          // If root exists and has content, we should have detected it - this is a timing issue
          // If root exists but truly empty, wait a bit more to see if content appears
          if (contentInfo.exists) {
            // Check if content actually exists but wasn't detected
            if ((contentInfo as any).hasContent) {
              this.log.warn(
                `Story ${story.id}: Content exists but wasn't detected properly. This may indicate a timing issue. Proceeding...`,
              );
              contentReady = true;
            } else {
              // Content doesn't exist yet, wait a bit more
              const remainingTime = contentWaitTimeout - (Date.now() - startTime);
              if (remainingTime > 1000) {
                // Give it a bit more time to see if content appears
                this.log.debug(
                  `Story ${story.id}: Root exists but empty, waiting ${Math.min(remainingTime, 2000)}ms more for content...`,
                );
                const extraWaitTime = Math.min(remainingTime, 2000); // Max 2 seconds extra
                const checkInterval = 200;
                const checkStart = Date.now();

                while (Date.now() - checkStart < extraWaitTime) {
                  if (page.isClosed()) {
                    break;
                  }

                  try {
                    const hasContent = await page.evaluate(() => {
                      try {
                        const root = document.getElementById('storybook-root');
                        if (!root) return false;

                        // Check multiple indicators of content
                        const hasChildren = root.children.length > 0;
                        const hasHTML = root.innerHTML.trim().length > 0;
                        const hasText = !!(root.textContent && root.textContent.trim().length > 0);
                        const hasDimensions = root.offsetHeight > 0 && root.offsetWidth > 0;
                        const hasGraphics = !!root.querySelector('canvas, svg');

                        return hasChildren || hasHTML || (hasText && hasDimensions) || hasGraphics;
                      } catch {
                        return false;
                      }
                    });

                    if (hasContent) {
                      contentReady = true;
                      this.log.debug(`Story ${story.id}: Content appeared after extra wait`);
                      break;
                    }
                  } catch (evalError: any) {
                    if (/target crashed|page crashed/i.test(String(evalError))) {
                      throw evalError;
                    }
                  }

                  await new Promise((resolve) => setTimeout(resolve, checkInterval));
                }

                // If still no content but root exists, proceed anyway (may be valid empty state)
                if (!contentReady) {
                  this.log.warn(
                    `Story ${story.id}: Root exists but remains empty after extra wait. Continuing (may be valid empty state)...`,
                  );
                  contentReady = true;
                }
              } else {
                // No time left, but root exists - proceed anyway
                this.log.warn(
                  `Story ${story.id}: Root exists but empty, no time left. Continuing anyway (may be empty state)...`,
                );
                contentReady = true;
              }
            }
          } else {
            // Capture a screenshot before throwing to help debug timeout issues
            // This ensures we have a diff even when content doesn't load
            try {
              if (!page.isClosed()) {
                const expected = path.join(this.config.snapshotPath, story.snapshotRelPath);
                const actual = path.join(
                  path.dirname(path.join(this.config.resultsPath, story.snapshotRelPath)),
                  path.basename(story.snapshotRelPath),
                );
                const actualDir = path.dirname(actual);
                fs.mkdirSync(actualDir, { recursive: true });
                this.log.debug(
                  `Story ${story.id}: Capturing screenshot on timeout - actual: ${actual}`,
                );
                await page.screenshot({
                  path: actual,
                  fullPage: this.config.fullPage,
                  type: 'png',
                });
                this.log.debug(`Story ${story.id}: Screenshot captured on timeout`);
              } else {
                this.log.debug(
                  `Story ${story.id}: Page is closed, cannot capture screenshot on timeout`,
                );
              }
            } catch (screenshotError: any) {
              const errorMsg = String(screenshotError);
              if (/target crashed|page crashed/i.test(errorMsg)) {
                this.log.debug(
                  `Story ${story.id}: Page crashed before screenshot could be captured. This may indicate resource constraints (memory/CPU) in the test environment.`,
                );
                // Enhance the error message to include crash information
                const crashError = new Error(
                  `Operation timed out. Browser crashed before screenshot could be captured (likely due to resource constraints). Original error: ${String(e)}`,
                );
                throw crashError;
              } else {
                this.log.debug(
                  `Story ${story.id}: Failed to capture screenshot on timeout: ${screenshotError}`,
                );
              }
            }
            // Check if the original error was a crash
            const originalErrorStr = String(e);
            if (
              /target crashed|page crashed/i.test(originalErrorStr) ||
              (contentInfo.error && /target crashed|page crashed/i.test(contentInfo.error))
            ) {
              const crashError = new Error(
                `Operation timed out. Browser crashed during content check (likely due to resource constraints). ${originalErrorStr}`,
              );
              throw crashError;
            }
            throw e;
          }
        } // End of catch block
      } // End of if (!contentReady) - skip wait if content already ready

      // Only proceed if content is ready (either loaded successfully or root exists)
      if (!contentReady) {
        throw new Error('Content check failed and root does not exist');
      }

      // Wait for Storybook's storyRendered event - most reliable way to know story is ready
      // This is emitted by Storybook when the story has fully rendered
      try {
        await page.evaluate(() => {
          return new Promise<void>((resolve) => {
            // Check if storybook API is available
            const storybookApi = (window as any).__STORYBOOK_CLIENT_API__;
            if (storybookApi) {
              // Listen for storyRendered event
              const channel = (window as any).__STORYBOOK_ADDONS_CHANNEL__;
              if (channel) {
                const handler = () => {
                  channel.removeListener('storyRendered', handler);
                  resolve();
                };
                channel.on('storyRendered', handler);
                // Timeout after 5 seconds
                setTimeout(() => {
                  channel.removeListener('storyRendered', handler);
                  resolve();
                }, 5000);
              } else {
                resolve();
              }
            } else {
              // Fallback: wait for loading overlay to disappear
              const loadingOverlay = document.querySelector('.sb-loading, [data-testid="loading"]');
              if (loadingOverlay) {
                const observer = new MutationObserver(() => {
                  if (
                    !document.contains(loadingOverlay) ||
                    loadingOverlay.classList.contains('hidden') ||
                    getComputedStyle(loadingOverlay).display === 'none'
                  ) {
                    observer.disconnect();
                    resolve();
                  }
                });
                observer.observe(document.body, {
                  childList: true,
                  subtree: true,
                  attributes: true,
                });
                setTimeout(() => {
                  observer.disconnect();
                  resolve();
                }, 3000);
              } else {
                resolve();
              }
            }
          });
        });
        this.log.debug(`Story ${story.id}: Storybook storyRendered event received`);
      } catch (e) {
        // If storyRendered check fails, continue anyway
        this.log.debug(`Story ${story.id}: Storybook storyRendered check failed, continuing: ${e}`);
      }

      // Font loading wait - ensure fonts are fully loaded before screenshot
      // This is critical for consistent rendering between local and CI
      await page.evaluate(async () => {
        const d = document as unknown as { fonts?: { ready?: Promise<void> } };
        if (d.fonts?.ready) {
          try {
            await Promise.race([
              d.fonts.ready,
              new Promise((resolve) => setTimeout(resolve, 5000)), // Increased timeout for CI environments
            ]);
          } catch {
            // Font loading failed, continue anyway
          }
        }
      });

      // Wait for DOM to stabilize: 300ms after last mutation, but timeout after 2000ms
      const quietPeriodMs = 300; // Wait 300ms after last mutation (increased for CI stability)
      const maxWaitMs = 2000; // But don't wait longer than 2000ms total (increased for slower CI)

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

      // Additional wait for animations and transitions to complete
      // Many UI components have CSS animations that start after DOM is ready
      // Increased wait time for CI environments where rendering can be slower
      this.log.debug(`Story ${story.id}: Waiting for animations to settle...`);
      await page.waitForTimeout(1000); // Wait 1000ms for animations to complete (increased for CI stability)

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

      // Pre-create directory to avoid contention (skip in update mode since we capture directly)
      if (!this.config.update) {
        const actualDir = path.dirname(path.join(this.config.resultsPath, story.snapshotRelPath));
        fs.mkdirSync(actualDir, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(expected), { recursive: true });
      }

      // Date is already fixed via context.addInitScript, no need for clock API

      // Capture screenshot with settings optimized for visual regression
      this.log.debug(
        `Story ${story.id}: Capturing screenshot${this.config.fullPage ? ' (full page)' : ''}...`,
      );
      const screenshotStart = Date.now();
      await page.screenshot({
        path: actual,
        fullPage: this.config.fullPage,
        type: 'png', // PNG format required for accurate odiff comparison
      });
      this.log.debug(`Story ${story.id}: Screenshot captured in ${Date.now() - screenshotStart}ms`);

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

                // Remove empty directories up to but not including resultsPath root
                const actualDir = path.dirname(actual);
                removeEmptyDirectories(actualDir, this.config.resultsPath);
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

      return { result, page };
    } finally {
      // Aggressive cleanup to prevent memory leaks
      // Note: We don't close page/browser here anymore - let the caller handle cleanup
      // so DOM dumps can access the page on timeout
      if (browser && !page) {
        // Only close browser if page was already closed
        try {
          if (browser.isConnected()) {
            await browser.close();
          }
        } catch (e) {
          // Ignore cleanup errors but log for debugging
          this.log.debug(`Warning: Failed to close browser for ${story.id}:`, e);
        }
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
    `Configuration: workers=${config.workers || 'default'}, retries=${config.retries}, threshold=${config.threshold}, update=${config.update}`,
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

  // Default to half of CPU cores to balance performance with memory constraints
  // Each browser worker can use significant memory, so we limit concurrency
  // Cap at 8 workers to prevent excessive memory usage even on high-core machines
  const cpuCount = os.cpus().length;
  const defaultWorkers = Math.min(8, Math.max(1, Math.floor(cpuCount / 2))); // Half cores, max 8, min 1
  const numWorkers = config.workers || defaultWorkers;
  log.debug(
    `Worker pool: ${numWorkers} workers (${cpuCount} CPU cores available, using ${defaultWorkers} by default)`,
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
  const initialMessage = `Running ${chalk.yellow(String(storyCount))} stories using ${chalk.yellow(String(numWorkers))} concurrent workers (${chalk.cyan(mode)})...`;
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
  const printUnderSpinner = (line: string) => {
    if (spinner) {
      const currentText = spinnerText;
      spinner.stop();
      spinner.clear();
      log.info(line);
      spinner = ora(currentText).start();
    } else {
      log.info(line);
    }
  };

  const pool = new WorkerPool(numWorkers, config, filteredStories, printUnderSpinner, callbacks);

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

  // Handle Ctrl+C: stop spinner immediately and show aborted message
  let abortHandled = false;
  const handleSigint = () => {
    if (abortHandled) return;
    abortHandled = true;
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

  // Progress callback
  const onProgress = (completed: number, total: number) => {
    if (spinner) {
      // Update spinner with progress information
      const percent = Math.round((completed / total) * 100);
      const elapsed = Date.now() - startTime;
      const avgTimePerTest = elapsed / Math.max(completed, 1);
      const remaining = (total - completed) * avgTimePerTest;
      const remainingSeconds = Math.round(remaining / 1000);
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;
      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      // Stories per minute (rounded, min 1 when there is progress)
      const elapsedMinutes = Math.max(elapsed / 60000, 0.001);
      const storiesPerMinute = completed > 0 ? Math.round(completed / elapsedMinutes) : 0;

      spinnerText = ` ${chalk.yellow(`${completed}/${total}`)} (${chalk.cyan(`${percent}%`)}) ${chalk.dim('•')} ${chalk.cyan(timeStr)} remaining ${chalk.dim('•')} ${chalk.magenta(`${storiesPerMinute}/m`)}`;
      spinner.text = spinnerText;
    }
  };

  try {
    // Run the tests
    log.debug('Starting worker pool execution...');
    const { success, failed } = await pool.run(onProgress);
    log.debug(`Worker pool completed: success=${success}, failed=${failed}`);

    // Clear progress and show final summary
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
