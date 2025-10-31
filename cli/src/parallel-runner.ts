/*
 * High-performance parallel test runner optimized for thousands of URLs
 * Uses a worker pool with controlled concurrency to avoid overwhelming the system
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, Browser, Page } from 'playwright';
import { compare as odiffCompare } from 'odiff-bin';
import type { RuntimeConfig } from './config.js';
import type { DiscoveredStory } from './core/StorybookDiscovery.js';
import { TerminalUI } from './terminal-ui.js';

type TestConfig = RuntimeConfig & {
  snapshotPath: string;
  resultsPath: string;
};

// Optimized worker pool for handling thousands of URLs
class WorkerPool {
  private queue: DiscoveredStory[] = [];
  private activeWorkers = 0;
  private maxWorkers: number;
  private results: { [storyId: string]: { success: boolean; error?: string; duration: number; action?: string } } = {};
  private startTime = Date.now();
  private completed = 0;
  private total: number;
  private config: TestConfig;
  private ui?: TerminalUI;
  private onProgress?: (completed: number, total: number, results: any) => void;
  private onComplete?: (results: any) => void;

  constructor(maxWorkers: number, config: TestConfig, stories: DiscoveredStory[], ui?: TerminalUI) {
    this.maxWorkers = maxWorkers;
    this.config = config;
    this.total = stories.length;
    this.queue = [...stories];
    this.ui = ui;
  }

  getResults() {
    return this.results;
  }

  async run(onProgress?: (completed: number, total: number, results: any) => void, onComplete?: (results: any) => void): Promise<{ success: boolean; failed: number }> {
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
          const failed = Object.values(this.results).filter(r => !r.success).length;
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
    let browser: Browser | undefined;
    let page: Page | undefined;

    // Start test in UI
    if (this.ui) {
      this.ui.startTest(story.id, story.id);
    }

    // Small random delay to stagger browser launches and reduce resource contention
    const delay = Math.random() * 50; // 0-50ms random delay
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
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
          '--disable-component-update' // Disable component updates
        ]
      });

      const viewport = this.config.perStory?.[story.id]?.viewport;
      const context = await browser.newContext({
        viewport: typeof viewport === 'object' ? viewport : undefined,
        // Reuse context for performance
      });

      page = await context.newPage();

      // Navigate and wait for story to load
      await page.goto(story.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for Storybook root to be attached
      await page.waitForSelector('#storybook-root', { state: 'attached', timeout: 10000 });

      // Wait for story content to actually load - Storybook specific waiting
      await page.waitForFunction(() => {
        const root = document.getElementById('storybook-root');
        if (!root) return false;

        // Check if story has meaningful content (not just loading)
        const hasContent = root.textContent && root.textContent.trim().length > 0;
        const hasChildren = root.children.length > 0;

        // For stories with canvas/charts, also check for canvas elements
        const hasCanvas = root.querySelector('canvas');

        return hasContent || hasChildren || hasCanvas;
      }, { timeout: 10000 });

      // Additional wait for any story-specific loading states
      await page.evaluate(async () => {
        // Wait for Storybook's loading overlay to disappear
        const loadingOverlay = document.querySelector('.sb-loading, [data-testid="loading"]');
        if (loadingOverlay) {
          // Wait for it to be removed or hidden
          await new Promise(resolve => {
            const observer = new MutationObserver(() => {
              if (!document.contains(loadingOverlay) ||
                  loadingOverlay.classList.contains('hidden') ||
                  getComputedStyle(loadingOverlay).display === 'none') {
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
            new Promise(resolve => setTimeout(resolve, 1000)) // Timeout after 1s
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

      if (!isStable && this.config.debug) {
        console.log(`Story ${story.id}: DOM still mutating after ${maxWaitMs}ms, taking screenshot anyway`);
      }

      // Optimized screenshot capture
      const expected = path.join(this.config.snapshotPath, story.snapshotRelPath);
      const actualDir = path.dirname(path.join(this.config.resultsPath, story.snapshotRelPath));
      const actual = path.join(actualDir, path.basename(story.snapshotRelPath));

      // Pre-create directory to avoid contention
      fs.mkdirSync(actualDir, { recursive: true });

      // Capture screenshot with settings optimized for visual regression
      await page.screenshot({
        path: actual,
        fullPage: this.config.fullPage,
        type: 'png' // PNG format required for accurate odiff comparison
      });

      // Handle baseline logic with odiff visual regression testing
      const missingBaseline = !fs.existsSync(expected);
      let result: string;

      if (this.config.debug) {
        console.log(`Story ${story.id}: expected=${expected}, actual=${actual}, missing=${missingBaseline}, update=${this.config.update}`);
      }

      if (missingBaseline) {
        if (this.config.update && this.config.missingOnly) {
          fs.mkdirSync(path.dirname(expected), { recursive: true });
          fs.copyFileSync(actual, expected);
          result = 'Created baseline';
        } else if (this.config.update) {
          fs.mkdirSync(path.dirname(expected), { recursive: true });
          fs.copyFileSync(actual, expected);
          result = 'Updated baseline';
        } else {
          throw new Error(`Missing baseline: ${expected}`);
        }
      } else {
        // Perform visual regression test using odiff
        const diffPath = path.join(path.dirname(actual), `${path.basename(actual, path.extname(actual))}.diff.png`);

        try {
          // Run odiff comparison using Node.js bindings
          const odiffResult = await odiffCompare(expected, actual, diffPath, {
            threshold: this.config.threshold,
            outputDiffMask: true
          });

          if (odiffResult.match) {
            // Images are identical within threshold
            result = 'Visual regression passed';

            // Clean up diff file if it exists (odiff creates it even for identical images)
            if (fs.existsSync(diffPath)) {
              try {
                fs.unlinkSync(diffPath);
              } catch (e) {
                // Ignore cleanup errors
              }
            }
          } else {
            // Images differ beyond threshold
            if (this.config.debug) {
              console.log(`Images differ for ${story.id}: ${odiffResult.reason}`);
            }

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

      const duration = Date.now() - startTime;
      this.results[story.id] = { success: true, duration, action: result };

      // Finish test in UI
      if (this.ui) {
        this.ui.finishTest(story.id, true);
      } else if (this.config.logLevel !== 'silent') {
        console.log(`✓ ${story.id}`);
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      this.results[story.id] = { success: false, error: String(error), duration, action: 'failed' };

      // Finish test in UI
      if (this.ui) {
        this.ui.finishTest(story.id, false, String(error), story.url);
      } else if (this.config.logLevel !== 'silent') {
        // Extract diff image path from error message for visual regression failures
        const errorStr = String(error);
        const diffMatch = errorStr.match(/diff: ([^\)]+)/);
        const diffPath = diffMatch ? diffMatch[1] : null;

        console.error(`✗ ${story.id}`);
        console.error(`  ${story.url}`);
        if (diffPath) {
          console.error(`  ${diffPath}`);
        }
      }
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
          if (this.config.debug) {
            console.log(`Warning: Failed to close page for ${story.id}:`, e);
          }
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
          if (this.config.debug) {
            console.log(`Warning: Failed to close browser for ${story.id}:`, e);
          }
        }
      }

      // Force garbage collection if available (Node.js with --expose-gc)
      if (typeof global !== 'undefined' && global.gc) {
        global.gc();
      }

      this.completed++;
      this.onProgress?.(this.completed, this.total, this.results);
    }
  }
}

export async function runParallelTests(options: {
  stories: DiscoveredStory[];
  config: TestConfig;
  runtimePath: string;
  debug: boolean;
}): Promise<number> {
  const { stories, config, debug } = options;

  if (stories.length === 0) {
    console.error('No stories to test');
    return 1;
  }

  // Check if we can use the terminal UI
  const useUI = TerminalUI.isSupported() && config.logLevel !== 'silent';
  const ui = useUI ? new TerminalUI(stories.length, config.showProgress) : null;

  // Default to number of CPU cores, with a reasonable cap
  const defaultWorkers = Math.min(os.cpus().length, 8); // Cap at 8 to avoid overwhelming the system
  const numWorkers = config.workers || defaultWorkers;

  const initialMessage = `Running ${stories.length} stories using ${numWorkers} concurrent workers`;
  if (ui) {
    ui.log(initialMessage);
  } else {
    console.log(initialMessage);
  }

  const pool = new WorkerPool(numWorkers, config, stories, ui || undefined);

  const startTime = Date.now();

  // Progress callback
  const onProgress = (completed: number, total: number) => {
    if (ui) {
      ui.updateProgress(completed, total, Date.now() - startTime);
    } else {
      // Fallback to simple progress line with better formatting
      const percent = Math.round((completed / total) * 100);
      const elapsed = Date.now() - startTime;
      const avgTimePerTest = elapsed / Math.max(completed, 1);
      const remaining = (total - completed) * avgTimePerTest;
      const remainingSeconds = Math.round(remaining / 1000);
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;
      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      // Clear line and position cursor to start, then print progress
      process.stdout.write('\r\x1b[K' + `📊 ${completed}/${total} (${percent}%) • ${timeStr} remaining`);
    }
  };

  try {
    // Run the tests
    const { success, failed } = await pool.run(onProgress);

    // Clear progress and show final summary
    if (!ui) {
      process.stdout.write('\r\x1b[K\n'); // Clear line and move to next line
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Calculate summary statistics from results
    const allResults = Object.values(pool.getResults());
    const passed = allResults.filter(r => r.action === 'Visual regression passed').length;
    const updated = allResults.filter(r => r.action === 'Updated baseline').length;
    const created = allResults.filter(r => r.action === 'Created baseline').length;
    const failedCount = allResults.filter(r => r.action === 'failed').length;
    const testsPerMinute = ((stories.length / (parseFloat(totalDuration) / 60))).toFixed(0);

    // Always show detailed summary at the end
    const summaryLines = [
      `📊 Summary:`,
      `  ✅ Passed: ${passed}`,
      `  ❌ Failed: ${failedCount}`,
      `  📸 Created: ${created}`,
      `  🔄 Updated: ${updated}`,
      `  ⏱️  Total time: ${totalDuration}s`,
      `  ⚡ Tests/min: ${testsPerMinute}`
    ];

    if (ui) {
      summaryLines.forEach(line => ui.log(line));
      ui.destroy();
    } else {
      summaryLines.forEach(line => console.log(line));
    }

    return success ? 0 : 1;
  } catch (error) {
    if (ui) {
      ui.error(`Unexpected error: ${error}`);
      ui.destroy();
    } else {
      console.error('Unexpected error:', error);
    }
    return 1;
  }
}
