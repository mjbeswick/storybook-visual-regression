import { chromium, firefox, webkit, Browser, Page } from 'playwright';
import type {
  VisualRegressionConfig,
  TestResult,
  TestResults,
  StorybookEntry,
} from '../types/index.js';
import { StorybookDiscovery } from './StorybookDiscovery.js';
import chalk from 'chalk';

export class VisualRegressionRunner {
  private config: VisualRegressionConfig;
  private browser: Browser | null = null;

  constructor(config: VisualRegressionConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const browserType = this.getBrowserType();
    this.browser = await browserType.launch({
      headless: this.config.headless,
    });
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async runTests(): Promise<TestResults> {
    if (!this.browser) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    const discovery = new StorybookDiscovery(this.config);

    // Discover viewport configurations if enabled
    if (this.config.discoverViewports) {
      console.log('Discovering viewport configurations from Storybook...');
      const discoveredViewports = await discovery.discoverViewportConfigurations();
      if (discoveredViewports && Object.keys(discoveredViewports).length > 0) {
        this.config.viewportSizes = discoveredViewports;
        console.log(
          `Discovered ${Object.keys(discoveredViewports).length} viewport configurations:`,
          Object.keys(discoveredViewports).join(', '),
        );
      }
    }

    const stories = await discovery.discoverStories();

    const filteredStories = this.filterStories(stories);
    const results: TestResult[] = [];
    let failures = 0;
    let stopRequested = false;

    const storiesQueue = [...filteredStories];
    const workerCount = Math.max(1, this.config.workers ?? 1);

    const runWorker = async () => {
      while (!stopRequested) {
        const story = storiesQueue.shift();
        if (!story) break;
        try {
          const result = await this.testStory(story);
          results.push(result);
          // Print list-style line with duration
          if (result.passed) {
            console.log(
              `${chalk.green('✓')} ${result.storyTitle} (${
                result.storyId
              }) ${chalk.gray('— ' + formatDuration(result.durationMs))}`,
            );
          } else {
            console.log(
              `${chalk.red('✗')} ${result.storyTitle} (${
                result.storyId
              }) ${chalk.gray('— ' + formatDuration(result.durationMs))}`,
            );
            if (result.error) {
              console.log(chalk.gray(`    ${result.error}`));
            }
          }
          if (!result.passed) {
            failures += 1;
          }
        } catch (error) {
          const failedResult: TestResult = {
            storyId: story.id,
            storyTitle: story.title ?? story.id,
            passed: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            durationMs: 0,
          };
          results.push(failedResult);
          console.log(
            `${chalk.red('✗')} ${failedResult.storyTitle} (${
              failedResult.storyId
            }) ${chalk.gray('— ' + formatDuration(failedResult.durationMs))}`,
          );
          if (failedResult.error) {
            console.log(chalk.gray(`    ${failedResult.error}`));
          }
          failures += 1;
        }

        if (this.config.maxFailures > 0 && failures >= this.config.maxFailures) {
          stopRequested = true;
          break;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    if (this.config.maxFailures > 0 && failures >= this.config.maxFailures) {
      console.log(`Reached max failures (${this.config.maxFailures}). Stopping early.`);
    }

    return {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
    };
  }

  private async testStory(story: StorybookEntry): Promise<TestResult> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const page = await this.browser.newPage();
    const startTime = Date.now();

    try {
      // Set viewport
      const viewportSize = this.config.viewportSizes[this.config.defaultViewport];
      await page.setViewportSize(viewportSize);

      // Set timezone and locale
      await page.addInitScript(() => {
        const timezone = 'UTC';
        const locale = 'en-US';
        Object.defineProperty(Intl, 'DateTimeFormat', {
          value: class extends Intl.DateTimeFormat {
            constructor(...args: any[]) {
              super(...args);
              if (args.length === 0) {
                super(locale, { timeZone: timezone });
              }
            }
          },
        });
      });

      // Disable animations if configured
      if (this.config.disableAnimations) {
        await page.addStyleTag({
          content: `
            *, *::before, *::after {
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
            }
          `,
        });
      }

      // Navigate to story
      const storyUrl = `${this.config.storybookUrl}/iframe.html?id=${story.id}`;
      await page.goto(storyUrl, {
        waitUntil: this.config.waitForNetworkIdle ? 'networkidle' : 'load',
        timeout: this.config.timeout,
      });

      // Wait for content stabilization
      if (this.config.contentStabilization) {
        await page.waitForTimeout(1000);
      }

      // Take screenshot
      const screenshotPath = `${this.config.snapshotPath}/${story.id}.png`;
      await page.screenshot({ path: screenshotPath });

      const durationMs = Date.now() - startTime;
      return {
        storyId: story.id,
        storyTitle: story.title ?? story.id,
        passed: true,
        snapshotPath: screenshotPath,
        durationMs,
      };
    } finally {
      await page.close();
    }
  }

  private filterStories(stories: StorybookEntry[]): StorybookEntry[] {
    let filtered = stories.filter((story) => story.type === 'story');

    if (this.config.includeStories && this.config.includeStories.length > 0) {
      filtered = filtered.filter((story) =>
        this.config.includeStories!.some(
          (pattern) => story.id.includes(pattern) || story.title.includes(pattern),
        ),
      );
    }

    if (this.config.excludeStories && this.config.excludeStories.length > 0) {
      filtered = filtered.filter(
        (story) =>
          !this.config.excludeStories!.some(
            (pattern) => story.id.includes(pattern) || story.title.includes(pattern),
          ),
      );
    }

    return filtered;
  }

  private getBrowserType() {
    switch (this.config.browser) {
      case 'firefox':
        return firefox;
      case 'webkit':
        return webkit;
      case 'chromium':
      default:
        return chromium;
    }
  }
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}
