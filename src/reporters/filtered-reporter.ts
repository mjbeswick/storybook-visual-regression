import {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import chalk from 'chalk';
import { existsSync, rmSync, statSync, readdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import ora from 'ora';
import type { Ora } from 'ora';

class FilteredReporter implements Reporter {
  private failures: TestCase[] = [];
  private failureDetails: Array<{ test: TestCase; diffPath?: string }> = [];
  private passed = 0;
  private failed = 0;
  private resultsRoot: string | null = null;
  private totalTests = 0;
  private completed = 0;
  private startedAtMs = 0;
  private workers = 1;
  private lastDurations: number[] = []; // rolling window across all workers (fallback)
  private perWorkerDurations: Record<number, number[]> = {}; // rolling window per worker
  private recentAllDurations: number[] = []; // for percentile/outlier capping
  private spinner: Ora | null = null;
  private isCI = false;
  private showTimeEstimates = true;
  private showSpinners = true;

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = Math.floor(s / 60);
    const rs = Math.round(s % 60);
    return `${m}m ${rs}s`;
  }

  private getResultsRoot(_config: FullConfig): string {
    if (this.resultsRoot) return this.resultsRoot;
    const base = process.env.PLAYWRIGHT_OUTPUT_DIR
      ? `${process.env.PLAYWRIGHT_OUTPUT_DIR}/results`
      : 'visual-regression/results';
    this.resultsRoot = base;
    return base;
  }

  private computeP95(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.floor(0.95 * (sorted.length - 1));
    return sorted[idx];
  }

  private safeRemoveEmptyDirsUp(startDir: string, stopDir: string): void {
    let cursor = startDir;
    // Only prune within the results root to avoid accidental removals
    while (cursor.startsWith(stopDir)) {
      try {
        const entries = readdirSync(cursor);
        if (entries.length > 0) break;
        rmSync(cursor, { recursive: true, force: true });
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      } catch {
        break;
      }
    }
  }

  private removePathIfExists(filePath: string): void {
    try {
      if (!existsSync(filePath)) return;
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        rmSync(filePath, { recursive: true, force: true });
      } else {
        unlinkSync(filePath);
      }
    } catch {
      // ignore cleanup errors
    }
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.getResultsRoot(config);
    this.totalTests = suite.allTests().length;
    this.completed = 0;
    this.startedAtMs = Date.now();
    const configuredWorkers = Number(config.workers);
    this.workers =
      Number.isFinite(configuredWorkers) && configuredWorkers > 0 ? configuredWorkers : 1;

    // Detect CI environment and configure display options
    this.isCI = process.env.CI === 'true' || process.env.CONTINUOUS_INTEGRATION === 'true';
    this.showTimeEstimates = !this.isCI && process.env.SVR_HIDE_TIME_ESTIMATES !== 'true';
    this.showSpinners = !this.isCI && process.env.SVR_HIDE_SPINNERS !== 'true';

    // Header line for tests and workers, followed by a newline as expected by tests
    console.log(`Running ${this.totalTests} tests using ${this.workers} workers\n`);

    if (this.showSpinners) {
      this.spinner = ora({
        text: chalk.gray(`0 ${chalk.dim('of')} ${this.totalTests} ${chalk.dim('estimating…')}`),
        isEnabled: true,
      }).start();
    }
  }

  onStdOut(_chunk: string | Buffer, _test?: TestCase, _result?: TestResult): void {
    // Suppress stdout
  }

  onStdErr(_chunk: string | Buffer, _test?: TestCase, _result?: TestResult): void {
    // Suppress stderr
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const displayTitle = test.title.replace(/^snapshots-/, '');
    const baseUrl = (process.env.STORYBOOK_URL || 'http://localhost:9009').replace(/\/$/, '');
    const idMatch = displayTitle.match(/\[(.*)\]$/);
    const storyIdForUrl = idMatch ? idMatch[1] : displayTitle;

    // Remove the redundant story ID in brackets for cleaner output
    let formattedTitle = displayTitle;
    if (idMatch) {
      formattedTitle = displayTitle.substring(0, displayTitle.lastIndexOf('[')).trim();
    }

    // Fix spacing issues and add colors to slashes and chevrons
    formattedTitle = formattedTitle
      .replace(/\s*\/\s*/g, ' / ') // Ensure consistent spacing around slashes
      .replace(/\s*›\s*/g, ' ❯ ') // Ensure consistent spacing around chevrons
      .replace(/\s+/g, ' ') // Remove extra spaces
      .trim();

    // Color the slashes and chevrons
    formattedTitle = formattedTitle
      .replace(/\s\/\s/g, ` ${chalk.blue.bold('/')} `)
      .replace(/\s❯\s/g, ` ${chalk.cyan.bold('❯')} `);

    const outputCore =
      process.env.SVR_PRINT_URLS === 'true'
        ? `${baseUrl}/iframe.html?id=${storyIdForUrl}&viewMode=story`
        : formattedTitle;

    // Update progress stats for ETA calculation
    this.completed += 1;
    const elapsedMs = Math.max(1, Date.now() - this.startedAtMs);
    const remaining = Math.max(0, this.totalTests - this.completed);
    const avgPerTestMs = elapsedMs / this.completed;
    const rawDuration = Math.max(1, result.duration || 0);
    // Outlier capping based on recent P95
    this.recentAllDurations.push(rawDuration);
    if (this.recentAllDurations.length > 100) this.recentAllDurations.shift();
    const p95 = this.computeP95(this.recentAllDurations) ?? rawDuration;
    const thisDuration = Math.min(rawDuration, p95);
    // Rolling average based on the number of workers (window size = workers)
    this.lastDurations.push(thisDuration);
    if (this.lastDurations.length > Math.max(1, this.workers)) {
      this.lastDurations.shift();
    }
    // Per-worker rolling windows
    const workerIndex = (result as unknown as { workerIndex?: number }).workerIndex ?? 0;
    if (!this.perWorkerDurations[workerIndex]) this.perWorkerDurations[workerIndex] = [];
    const windowSize = Math.max(1, this.workers);
    const wdur = this.perWorkerDurations[workerIndex];
    wdur.push(thisDuration);
    if (wdur.length > windowSize) wdur.shift();
    // Choose basis: early stage use global avg; later use per-worker window avg
    let etaBasis: number;
    const earlyThreshold = Math.max(this.workers * 2, 10);
    if (this.completed < earlyThreshold) {
      etaBasis = avgPerTestMs;
    } else {
      const workerKeys = Object.keys(this.perWorkerDurations);
      const perWorkerAverages: number[] = [];
      for (const k of workerKeys) {
        const list = this.perWorkerDurations[Number(k)] || [];
        if (list.length > 0) {
          const a = list.reduce((s, v) => s + v, 0) / list.length;
          perWorkerAverages.push(a);
        }
      }
      if (perWorkerAverages.length > 0) {
        etaBasis = perWorkerAverages.reduce((s, v) => s + v, 0) / perWorkerAverages.length;
      } else {
        etaBasis = this.lastDurations.reduce((s, v) => s + v, 0) / this.lastDurations.length;
      }
    }
    const etaMs = (etaBasis * remaining) / Math.max(1, this.workers);

    // Format test duration with color
    const testDuration = this.formatDuration(rawDuration);
    const durationColor =
      rawDuration > 10000 ? chalk.red.bold : rawDuration > 5000 ? chalk.yellow.bold : chalk.green;

    // Remove brackets and color the time units
    const durationText = ` ${durationColor(testDuration.replace(/(\d+)([a-zA-Z]+)/g, `$1${chalk.gray('$2')}`))}`;

    // Create progress label with optional time estimate
    let progressLabel = `${chalk.cyan(String(this.completed))} ${chalk.dim('of')} ${chalk.cyan(String(this.totalTests))}`;
    if (this.showTimeEstimates && remaining > 0) {
      const etaFormatted = this.formatDuration(Math.round(etaMs));
      progressLabel += ` ${chalk.gray(`~${etaFormatted} remaining`)}`;
    }

    if (this.spinner) {
      this.spinner.text = progressLabel;
    }

    if (result.status === 'failed') {
      this.failures.push(test);
      this.failed++;

      // Find the diff image path
      let diffPath: string | undefined;
      for (const attachment of result.attachments || []) {
        if (!attachment.path) continue;
        const name = (attachment.name || '').toLowerCase();
        if (name.includes('diff')) {
          diffPath = attachment.path;
          break;
        }
      }

      // Store failure details with diff path
      this.failureDetails.push({ test, diffPath });

      if (this.spinner) {
        this.spinner.stop();
      }
      // Show failed test with duration and red cross
      console.log(`  ${chalk.red.bold('✘')} ${outputCore}${durationText}`);
      if (this.spinner) {
        this.spinner.start(progressLabel);
      }
      // Keep diffs, remove non-diff attachments for failures
      for (const attachment of result.attachments || []) {
        if (!attachment.path) continue;
        const name = (attachment.name || '').toLowerCase();
        if (name.includes('diff')) continue;
        this.removePathIfExists(attachment.path);
      }
    } else if (result.status === 'passed') {
      this.passed++;
      if (this.spinner) {
        this.spinner.stop();
      }
      // Show passed test with duration and green tick
      console.log(`  ${chalk.green.bold('✔')} ${outputCore}${durationText}`);
      if (this.spinner) {
        this.spinner.start(progressLabel);
      }
      // Remove all artifacts for passed tests and prune empty folders up to results root
      for (const attachment of result.attachments || []) {
        if (!attachment.path) continue;
        const attachmentDir = dirname(attachment.path);
        this.removePathIfExists(attachment.path);
        const root = this.resultsRoot || '';
        this.safeRemoveEmptyDirsUp(attachmentDir, root);
      }
    }
  }

  onEnd(result: FullResult): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }

    // Summary line expected by tests, prefixed with a newline
    console.log(`\n${this.passed} passed, ${this.failed} failed`);

    if (result.status === 'failed' || this.failed > 0) {
      console.log(chalk.red('✘ Some tests failed'));

      // Show failure summary with URLs and diff paths if there are failures
      if (this.failureDetails.length > 0) {
        console.log(chalk.yellow('\n📋 Failed Tests Summary:'));
        const baseUrl = (process.env.STORYBOOK_URL || 'http://localhost:9009').replace(/\/$/, '');

        this.failureDetails.forEach((failure, index) => {
          const displayTitle = failure.test.title.replace(/^snapshots-/, '');
          const idMatch = displayTitle.match(/\[(.*)\]$/);
          const storyIdForUrl = idMatch ? idMatch[1] : displayTitle;
          const storyUrl = `${baseUrl}/iframe.html?id=${storyIdForUrl}&viewMode=story`;

          console.log(chalk.red(`${index + 1}. ${displayTitle}`));
          console.log(chalk.blue(`   🔗 ${storyUrl}`));
          if (failure.diffPath) {
            console.log(chalk.magenta(`   📸 ${failure.diffPath}`));
          }
        });

        console.log(
          chalk.dim(`\n💡 Tip: Set SVR_PRINT_URLS=true to see URLs inline with test results`),
        );
      }
    }
  }
}

export default FilteredReporter;
