/*
 * High-performance parallel test runner optimized for thousands of URLs
 * Uses a worker pool with controlled concurrency to avoid overwhelming the system
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, Browser, Page } from 'playwright';
import { compare as odiffCompare } from 'odiff-bin';
import ora from 'ora';
import chalk from 'chalk';
import type { RuntimeConfig } from './config.js';
import type { DiscoveredStory } from './core/StorybookDiscovery.js';
import { TerminalUI } from './terminal-ui.js';
import type { RunCallbacks } from './core/VisualRegressionRunner.js';
import { createLogger, setGlobalLogger } from './logger.js';

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
  private ui?: TerminalUI;
  private onProgress?: (completed: number, total: number, results: any) => void;
  private onComplete?: (results: any) => void;
  private singleLineMode: boolean;
  private printUnderSpinner?: (line: string) => void;
  private callbacks?: RunCallbacks;
  private log: ReturnType<typeof createLogger>;

  constructor(
    maxWorkers: number,
    config: TestConfig,
    stories: DiscoveredStory[],
    ui?: TerminalUI,
    printUnderSpinner?: (line: string) => void,
    callbacks?: RunCallbacks,
  ) {
    this.maxWorkers = maxWorkers;
    this.config = config;
    this.total = stories.length;
    this.queue = [...stories];
    this.ui = ui;
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
    // Handle UI mode
    if (this.ui) {
      this.ui.finishTest(story.id, result !== 'failed', errorDetails?.reason);
      return;
    }

    // Skip output if quiet mode
    if (this.config.quiet) {
      return;
    }

    // Helper to format duration with performance-based coloring and braces
    const colorDuration = (durationMs: number): string => {
      const secs = durationMs / 1000;
      const secsStr = secs.toFixed(1);
      const unit = 's';
      const formatted = `[${secsStr}${unit}]`;
      if (secs < 2) {
        return chalk.green(formatted);
      } else if (secs < 4) {
        return chalk.yellow(formatted);
      } else {
        return chalk.red(formatted);
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
        coloredReason = chalk.blue(reason);
      } else if (reason === 'No baseline snapshot found') {
        coloredReason = chalk.cyan(reason);
      } else {
        coloredReason = chalk.red(reason); // Default to red for unknown errors
      }

      const detailLines = [`  ${coloredReason}`, `  ${chalk.gray(`URL: ${errorDetails.url}`)}`];

      if (errorDetails.diffPath) {
        detailLines.push(`  ${chalk.gray(`Diff: ${errorDetails.diffPath}`)}`);
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
    while (this.queue.length > 0 && this.activeWorkers < this.maxWorkers) {
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

    // Start test in UI
    if (this.ui) {
      this.ui.startTest(story.id, displayName);
    }

    // Retry logic: attempt up to retries + 1 times (initial attempt + retries)
    const maxAttempts = (this.config.retries || 0) + 1;
    let lastError: Error | null = null;
    let result: string | null = null;

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
        result = await this.executeSingleTestAttempt(story);
        const attemptDuration = Date.now() - attemptStart;
        this.log.debug(`Story ${story.id}: Attempt ${attempt} succeeded in ${attemptDuration}ms`);
        lastError = null;
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error as Error;
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
      const isMissingBaseline = lastError && String(lastError).includes('Missing baseline');

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

        // Extract diff image path from error message for visual regression failures
        const errorStr = lastError ? String(lastError) : '';
        const diffMatch = errorStr.match(/diff: (.+)\)/);
        const diffPath = diffMatch ? diffMatch[1] : null;

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
        const printErrorStr = lastError ? String(lastError) : '';
        const printDiffMatch = printErrorStr.match(/diff: (.+)\)/);
        const printDiffPath = printDiffMatch ? printDiffMatch[1] : undefined;

        // Extract a user-friendly error message
        let errorReason = 'Unknown error';
        if (lastError) {
          const errorStr = String(lastError);
          if (errorStr.includes('Missing baseline')) {
            errorReason = 'No baseline snapshot found';
          } else if (errorStr.includes('odiff')) {
            errorReason = 'Visual differences detected';
          } else if (errorStr.includes('timeout')) {
            errorReason = 'Operation timed out';
          } else if (errorStr.includes('network')) {
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

  private async executeSingleTestAttempt(story: DiscoveredStory): Promise<string> {
    let browser: Browser | undefined;
    let page: Page | undefined;

    try {
      const browserStart = Date.now();
      this.log.debug(`Story ${story.id}: Launching browser...`);
      // Launch browser with aggressive memory optimization for parallel execution
      browser = await chromium.launch({
        headless: true,
        args: [
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
        ],
      });
      this.log.debug(`Story ${story.id}: Browser launched in ${Date.now() - browserStart}ms`);

      const viewport = this.config.perStory?.[story.id]?.viewport;
      this.log.debug(
        `Story ${story.id}: Creating browser context${viewport ? ` with viewport: ${JSON.stringify(viewport)}` : ''}...`,
      );
      const context = await browser.newContext({
        viewport: typeof viewport === 'object' ? viewport : undefined,
        // Reuse context for performance
      });

      page = await context.newPage();
      this.log.debug(`Story ${story.id}: New page created`);

      // Date mocking will be applied after navigation to avoid interfering with page initialization

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
      this.log.debug(`Story ${story.id}: Navigating to ${story.url}...`);
      const navStart = Date.now();
      await page.goto(story.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this.log.debug(`Story ${story.id}: Navigation completed in ${Date.now() - navStart}ms`);

      // Wait for Storybook root to be attached
      this.log.debug(`Story ${story.id}: Waiting for #storybook-root...`);
      await page.waitForSelector('#storybook-root', { state: 'attached', timeout: 10000 });
      this.log.debug(`Story ${story.id}: Storybook root found`);

      // Date mocking temporarily disabled - causing application hangs
      // TODO: Implement safer Date mocking approach if needed

      // Wait for story content to actually load - Storybook specific waiting
      await page.waitForFunction(
        () => {
          const root = document.getElementById('storybook-root');
          if (!root) return false;

          // Check if story has meaningful content (not just loading)
          const hasContent = root.textContent && root.textContent.trim().length > 0;
          const hasChildren = root.children.length > 0;

          // For stories with canvas/charts, also check for canvas elements
          const hasCanvas = root.querySelector('canvas');

          return hasContent || hasChildren || hasCanvas;
        },
        { timeout: 10000 },
      );

      // Additional wait for any story-specific loading states
      await page.evaluate(async () => {
        // Wait for Storybook's loading overlay to disappear
        const loadingOverlay = document.querySelector('.sb-loading, [data-testid="loading"]');
        if (loadingOverlay) {
          // Wait for it to be removed or hidden
          await new Promise((resolve) => {
            const observer = new MutationObserver(() => {
              if (
                !document.contains(loadingOverlay) ||
                loadingOverlay.classList.contains('hidden') ||
                getComputedStyle(loadingOverlay).display === 'none'
              ) {
                observer.disconnect();
                resolve(void 0);
              }
            });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true });

            // Timeout after 3 seconds
            setTimeout(() => {
              observer.disconnect();
              resolve(void 0);
            }, 3000);
          });
        }
      });

      // Font loading wait
      await page.evaluate(async () => {
        const d = document as unknown as { fonts?: { ready?: Promise<void> } };
        if (d.fonts?.ready) {
          await Promise.race([
            d.fonts.ready,
            new Promise((resolve) => setTimeout(resolve, 1000)), // Timeout after 1s
          ]);
        }
      });

      // Wait for DOM to stabilize: 200ms after last mutation, but timeout after 1000ms
      const quietPeriodMs = 200; // Wait 200ms after last mutation
      const maxWaitMs = 1000; // But don't wait longer than 1000ms total

      const isStable = await page.evaluate(
        ({ quietPeriodMs, maxWaitMs }) => {
          return new Promise<boolean>((resolve) => {
            const start = Date.now();
            let lastMutation = Date.now();

            const obs = new MutationObserver(() => {
              lastMutation = Date.now();
            });

            obs.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });

            const checkStability = () => {
              const now = Date.now();
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
      this.log.debug(`Story ${story.id}: Waiting for animations to settle...`);
      await page.waitForTimeout(500); // Wait 500ms for animations to complete

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

      // Apply Date fix right before screenshot capture if enabled
      // This is the safest point - page is fully loaded but screenshot not yet taken
      if (this.config.fixDate && !page.isClosed()) {
        try {
          const parseFixDate = (value: boolean | string | number | undefined): Date => {
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
          };

          const fixedDate = parseFixDate(this.config.fixDate);
          this.log.debug(
            `Story ${story.id}: Setting fixed clock time to ${fixedDate.toISOString()}`,
          );

          // Use Playwright's built-in clock API for reliable time mocking
          await page.clock.setFixedTime(fixedDate);

          this.log.debug(`Story ${story.id}: Clock time set successfully`);
        } catch (e) {
          this.log.debug(`Story ${story.id}: Failed to set clock time:`, e);
          // Don't throw - continue with screenshot even if clock setting fails
        }
      }

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
        throw new Error(`Missing baseline: ${expected}`);
      } else {
        // Perform visual regression test using odiff
        const diffPath = path.join(
          path.dirname(actual),
          `${path.basename(actual, path.extname(actual))}.diff.png`,
        );

        try {
          // Run odiff comparison using Node.js bindings
          this.log.debug(
            `Story ${story.id}: Comparing images with threshold: ${this.config.threshold}`,
          );
          const compareStart = Date.now();
          const odiffResult = await odiffCompare(expected, actual, diffPath, {
            threshold: this.config.threshold,
            outputDiffMask: true,
          });
          this.log.debug(
            `Story ${story.id}: Image comparison completed in ${Date.now() - compareStart}ms, match: ${odiffResult.match}`,
          );

          if (odiffResult.match) {
            // Images are identical within threshold
            result = 'Visual regression passed';
            this.log.debug(`Story ${story.id}: Visual regression test passed`);

            // Clean up diff file if it exists (odiff creates it even for identical images)
            if (fs.existsSync(diffPath)) {
              try {
                fs.unlinkSync(diffPath);
                this.log.debug(`Story ${story.id}: Cleaned up diff file`);
              } catch (e) {
                // Ignore cleanup errors
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
          if (error.message.includes('images differ')) {
            throw error; // Re-throw our own error
          } else {
            throw new Error(`odiff comparison failed: ${error.message}`);
          }
        }
      }

      return result;
    } finally {
      // Aggressive cleanup to prevent memory leaks
      if (page) {
        try {
          // Close all contexts and pages
          const context = page.context();
          await page.close();

          // Close context if it exists
          try {
            await context.close();
          } catch (e) {
            // Context might already be closed
          }
        } catch (e) {
          // Ignore cleanup errors but log for debugging
          this.log.debug(`Warning: Failed to close page for ${story.id}:`, e);
        }
      }

      if (browser) {
        try {
          // Ensure browser is fully closed
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

  // Prefer single-line spinner when --summary or --progress is passed; otherwise allow TUI
  // Disable TUI in quiet mode as well
  const useUI =
    TerminalUI.isSupported() && !config.quiet && !config.summary && !config.showProgress;
  const ui = useUI ? new TerminalUI(stories.length, config.showProgress) : null;
  log.debug(`UI mode: ${useUI ? 'TerminalUI' : ui === null ? 'none' : 'spinner'}`);

  // Default to number of CPU cores, with a reasonable cap
  const defaultWorkers = Math.min(os.cpus().length, 8); // Cap at 8 to avoid overwhelming the system
  const numWorkers = config.workers || defaultWorkers;
  log.debug(`Worker pool: ${numWorkers} workers (${os.cpus().length} CPU cores available)`);

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
  if (ui) {
    ui.log(initialMessage);
  } else if (!config.quiet) {
    log.info(initialMessage);
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

  const pool = new WorkerPool(
    numWorkers,
    config,
    filteredStories,
    ui || undefined,
    printUnderSpinner,
    callbacks,
  );

  const startTime = Date.now();

  // Create ora spinner when --progress or --summary is passed (even in quiet), and not using UI
  let spinner = !ui && (config.showProgress || config.summary) ? ora() : null;
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
    if (ui) {
      ui.updateProgress(completed, total, Date.now() - startTime);
    } else if (spinner) {
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
    } else if (!ui) {
      process.stdout.write('\r\x1b[K\n'); // Clear line and move to next line
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

      if (ui) {
        message.split('\n').forEach((line) => ui.log(line));
        ui.destroy();
      } else {
        log.info('\n' + message);
      }
    } else {
      if (ui) {
        ui.destroy();
      }
    }

    return success ? 0 : 1;
  } catch (error) {
    if (spinner) {
      spinner.stop();
      spinner.clear();
    }
    if (ui) {
      ui.error(`Unexpected error: ${error}`);
      ui.destroy();
    } else {
      log.error('Unexpected error:', error);
    }
    return 1;
  }
}
