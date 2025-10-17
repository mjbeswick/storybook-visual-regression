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
import { dirname, resolve, sep } from 'path';
import ora from 'ora';
import type { Ora } from 'ora';
import { tryLoadRuntimeOptions } from '../runtime/runtime-options.js';

class FilteredReporter implements Reporter {
  private runtimeOptions = tryLoadRuntimeOptions();
  private failures: TestCase[] = [];
  private failureDetails: Array<{
    test: TestCase;
    diffPath?: string;
    retry?: number;
    error?: string;
  }> = [];
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private timedOut = 0;
  private interrupted = 0;
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
  private firstBatchCompleted = false;
  private firstBatchSize = 0;
  private averageTestDuration = 0;
  private estimationConfidence: 'low' | 'medium' | 'high' = 'low';
  private recentTestDurations: number[] = [];
  private smoothedAverage = 0;
  private lastEstimationUpdate = 0;

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
    const resolved =
      this.runtimeOptions?.visualRegression.resultsPath ?? 'visual-regression/results';
    this.resultsRoot = resolved;
    return resolved;
  }

  private computeP95(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.floor(0.95 * (sorted.length - 1));
    return sorted[idx];
  }

  private calculateRobustEstimate(): { etaMs: number; confidence: 'low' | 'medium' | 'high' } {
    const remaining = Math.max(0, this.totalTests - this.completed);
    if (remaining === 0) return { etaMs: 0, confidence: 'high' };

    // Use actual test durations for more accurate estimates
    let avgTestDuration: number;
    let confidence: 'low' | 'medium' | 'high';

    if (this.recentTestDurations.length >= 3) {
      // Use recent test durations for trend-based estimation
      const recentSum = this.recentTestDurations.reduce((sum, d) => sum + d, 0);
      avgTestDuration = recentSum / this.recentTestDurations.length;
      confidence = this.recentTestDurations.length >= 10 ? 'high' : 'medium';
    } else if (this.completed >= 3) {
      // Fallback to elapsed time per test, but account for parallelism
      const elapsedMs = Math.max(1, Date.now() - this.startedAtMs);
      const wallClockTimePerTest = elapsedMs / this.completed;

      // Estimate actual test duration by accounting for parallel execution
      // If we have multiple workers, tests run in parallel, so wall-clock time per test
      // is roughly the actual test duration divided by effective workers
      const effectiveWorkers = Math.min(this.workers, this.completed);
      avgTestDuration = wallClockTimePerTest * effectiveWorkers;
      confidence = 'low';
    } else {
      // Very early stage - use simple elapsed time approach
      const elapsedMs = Math.max(1, Date.now() - this.startedAtMs);
      avgTestDuration = elapsedMs / this.completed;
      confidence = 'low';
    }

    // Apply smoothing to reduce volatility
    if (this.smoothedAverage === 0) {
      this.smoothedAverage = avgTestDuration;
    } else {
      const alpha = Math.min(0.4, 3 / (this.completed + 1)); // More responsive smoothing
      this.smoothedAverage = alpha * avgTestDuration + (1 - alpha) * this.smoothedAverage;
    }

    // Use smoothed average for final estimate
    const finalTestDuration = this.smoothedAverage;

    // Calculate ETA based on remaining tests and worker parallelism
    let etaMs: number;

    if (this.workers === 1) {
      // Single worker: straightforward calculation
      etaMs = finalTestDuration * remaining;
    } else {
      // Multi-worker: account for parallel execution
      // Use conservative efficiency factors
      const efficiencyFactor = Math.min(0.75, 0.4 + (0.25 * Math.log(this.workers)) / Math.log(2));
      const effectiveWorkers = this.workers * efficiencyFactor;

      // Calculate remaining work considering parallel execution
      const remainingWork = finalTestDuration * remaining;
      etaMs = remainingWork / effectiveWorkers;

      // Add buffer for coordination overhead and uncertainty
      etaMs *= 1.2;
    }

    return { etaMs, confidence };
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

  private isWithinResultsRoot(filePath: string): boolean {
    if (!this.resultsRoot) return false;
    const normalizedRoot = resolve(this.resultsRoot);
    const normalizedPath = resolve(filePath);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + sep);
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
    this.isCI = this.runtimeOptions?.isCI ?? false;
    this.showTimeEstimates =
      !this.isCI && !(this.runtimeOptions?.hideTimeEstimates ?? false);
    this.showSpinners = !this.isCI && !(this.runtimeOptions?.hideSpinners ?? false);

    // Set first batch size for improved time estimation
    this.firstBatchSize = Math.min(Math.max(this.workers * 2, 5), Math.floor(this.totalTests / 3));
    this.firstBatchCompleted = false;
    this.averageTestDuration = 0;
    this.estimationConfidence = 'low';
    this.recentTestDurations = [];
    this.smoothedAverage = 0;
    this.lastEstimationUpdate = 0;

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
    const baseUrl = (this.runtimeOptions?.storybookUrl ?? 'http://localhost:9009').replace(/\/$/, '');
    const idMatch = displayTitle.match(/\[(.*)\]$/);
    const storyIdForUrl = idMatch ? idMatch[1] : displayTitle;

    // Check if this is a retry attempt
    const retrySuffix = result.retry ? ` (attempt ${result.retry + 1})` : '';

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

    // Split the title into category path and story name
    const chevronIndex = formattedTitle.lastIndexOf(' ❯ ');
    let categoryPath = '';
    let storyName = '';

    if (chevronIndex !== -1) {
      categoryPath = formattedTitle.substring(0, chevronIndex + 3); // Include the chevron
      storyName = formattedTitle.substring(chevronIndex + 3); // Story name after chevron
    } else {
      categoryPath = formattedTitle;
    }

    // Color the category path (slashes and chevrons)
    categoryPath = categoryPath
      .replace(/\s\/\s/g, ` ${chalk.cyan.bold('/')} `)
      .replace(/\s❯\s/g, ` ${chalk.cyan.bold('❯')} `);

    // Combine colored category path with uncolored story name and retry suffix
    formattedTitle = categoryPath + storyName + retrySuffix;

    const outputCore = this.runtimeOptions?.printUrls
      ? `${baseUrl}/iframe.html?id=${storyIdForUrl}&viewMode=story`
      : formattedTitle;

    // Update progress stats for ETA calculation
    this.completed += 1;
    const remaining = Math.max(0, this.totalTests - this.completed);
    const rawDuration = Math.max(1, result.duration || 0);

    // Update recent test durations for trend analysis
    this.recentTestDurations.push(rawDuration);
    if (this.recentTestDurations.length > 10) {
      this.recentTestDurations.shift();
    }

    // Update duration tracking for outlier capping
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

    // Calculate robust time estimation
    const { etaMs, confidence } = this.calculateRobustEstimate();
    this.estimationConfidence = confidence;

    // Format test duration with color
    const testDuration = this.formatDuration(rawDuration);

    // Color the time units with the same color as the number but lighter
    const durationText = ` ${testDuration.replace(
      /(\d+(?:\.\d+)?)([a-zA-Z]+)/g,
      (match, number, unit) => {
        const baseColor =
          rawDuration > 10000 ? chalk.red : rawDuration > 5000 ? chalk.yellow : chalk.green;
        return `${baseColor(number)}${baseColor.dim(unit)}`;
      },
    )}`;

    // Create progress label with percentage and optional time estimate
    const percentage = Math.round((this.completed / this.totalTests) * 100);
    let progressLabel = `${chalk.cyan(String(this.completed))} ${chalk.dim('of')} ${chalk.cyan(String(this.totalTests))} ${chalk.gray(`(${percentage}%)`)}`;

    // Show time estimates with confidence indicators
    if (this.showTimeEstimates && remaining > 0) {
      const etaFormatted = this.formatDuration(Math.round(etaMs));
      let confidenceIndicator = '';

      switch (confidence) {
        case 'low':
          confidenceIndicator = chalk.yellow('~');
          break;
        case 'medium':
          confidenceIndicator = chalk.blue('≈');
          break;
        case 'high':
          confidenceIndicator = chalk.green('≈');
          break;
      }

      progressLabel += ` ${chalk.gray(`${confidenceIndicator}${etaFormatted} remaining`)}`;
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

      // Store failure details with diff path, retry information, and error message
      const errorMessage = result.error?.message || result.error?.toString() || 'Unknown error';
      this.failureDetails.push({ test, diffPath, retry: result.retry, error: errorMessage });

      if (this.spinner) {
        this.spinner.stop();
        this.spinner.clear();
      }
      // Show failed test with duration and red cross
      console.log(`  ${chalk.red.bold('✘')} ${outputCore}${durationText}`);
      if (this.spinner) {
        this.spinner.start(progressLabel);
      }
      // Keep diffs, remove non-diff attachments for failures
      for (const attachment of result.attachments || []) {
        if (!attachment.path) continue;
        if (!this.isWithinResultsRoot(attachment.path)) continue;
        const name = (attachment.name || '').toLowerCase();
        if (name.includes('diff')) continue;
        this.removePathIfExists(attachment.path);
      }
    } else if (result.status === 'passed') {
      this.passed++;
      if (this.spinner) {
        this.spinner.stop();
        this.spinner.clear();
      }
      // Show passed test with duration and green tick
      console.log(`  ${chalk.green.bold('✔')} ${outputCore}${durationText}`);
      if (this.spinner) {
        this.spinner.start(progressLabel);
      }
      // Remove all artifacts for passed tests and prune empty folders up to results root
      for (const attachment of result.attachments || []) {
        if (!attachment.path) continue;
        if (!this.isWithinResultsRoot(attachment.path)) continue;
        const attachmentDir = dirname(attachment.path);
        this.removePathIfExists(attachment.path);
        const root = this.resultsRoot || '';
        this.safeRemoveEmptyDirsUp(attachmentDir, root);
      }
    } else if (result.status === 'skipped') {
      this.skipped++;
      if (this.spinner) {
        this.spinner.stop();
        this.spinner.clear();
      }
      // Show skipped test with duration and yellow dash
      console.log(`  ${chalk.yellow.bold('-')} ${outputCore}${durationText}`);
      if (this.spinner) {
        this.spinner.start(progressLabel);
      }
      // Remove all artifacts for skipped tests
      for (const attachment of result.attachments || []) {
        if (!attachment.path) continue;
        if (!this.isWithinResultsRoot(attachment.path)) continue;
        this.removePathIfExists(attachment.path);
      }
    } else if (result.status === 'timedOut') {
      this.failures.push(test);
      this.timedOut++;

      // Store timeout details
      const errorMessage = result.error?.message || result.error?.toString() || 'Test timeout';
      this.failureDetails.push({ test, retry: result.retry, error: errorMessage });

      if (this.spinner) {
        this.spinner.stop();
        this.spinner.clear();
      }
      // Show timed out test with duration and red clock
      console.log(`  ${chalk.red.bold('⏰')} ${outputCore}${durationText}`);
      if (this.spinner) {
        this.spinner.start(progressLabel);
      }
      // Keep artifacts for timed out tests (they might be useful for debugging)
    } else if (result.status === 'interrupted') {
      this.interrupted++;
      if (this.spinner) {
        this.spinner.stop();
        this.spinner.clear();
      }
      // Show interrupted test with duration and red stop sign
      console.log(`  ${chalk.red.bold('⏹')} ${outputCore}${durationText}`);
      if (this.spinner) {
        this.spinner.start(progressLabel);
      }
      // Keep artifacts for interrupted tests (they might be useful for debugging)
    }
  }

  onEnd(result: FullResult): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }

    // Summary line expected by tests, prefixed with a newline
    const totalExecuted =
      this.passed + this.failed + this.skipped + this.timedOut + this.interrupted;
    console.log(
      `\n${this.passed} passed, ${this.failed} failed${this.skipped > 0 ? `, ${this.skipped} skipped` : ''}${this.timedOut > 0 ? `, ${this.timedOut} timed out` : ''}${this.interrupted > 0 ? `, ${this.interrupted} interrupted` : ''}`,
    );

    // Show discrepancy if total executed doesn't match total tests
    if (totalExecuted !== this.totalTests) {
      console.log(
        chalk.yellow(`⚠ Expected ${this.totalTests} tests, but ${totalExecuted} were executed`),
      );
    }

    // Handle different test execution outcomes
    if (result.status === 'interrupted' || result.status === 'timedout') {
      console.log(chalk.yellow.bold('⚠ Test execution aborted'));
    } else if (this.failed > 0 || this.timedOut > 0 || this.interrupted > 0) {
      console.log(chalk.red.bold('✘ Some tests failed'));

      // Show failure summary with URLs and diff paths if there are failures
      if (this.failureDetails.length > 0) {
        console.log(chalk.yellow('\n📋 Failed Tests Summary:'));
        const baseUrl = (this.runtimeOptions?.storybookUrl ?? 'http://localhost:9009').replace(
          /\/$/,
          '',
        );

        // Deduplicate failures by test title (keep the first occurrence)
        const uniqueFailures = new Map<string, (typeof this.failureDetails)[0]>();
        this.failureDetails.forEach((failure) => {
          const displayTitle = failure.test.title.replace(/^snapshots-/, '');
          if (!uniqueFailures.has(displayTitle)) {
            uniqueFailures.set(displayTitle, failure);
          }
        });

        // Sort failures alphabetically by test title
        const sortedFailures = Array.from(uniqueFailures.entries()).sort(([a], [b]) =>
          a.localeCompare(b),
        );

        sortedFailures.forEach(([displayTitle, failure], index) => {
          const idMatch = displayTitle.match(/\[(.*)\]$/);
          const storyIdForUrl = idMatch ? idMatch[1] : displayTitle;
          const storyUrl = `${baseUrl}/iframe.html?id=${storyIdForUrl}&viewMode=story`;

          console.log(chalk.red(`${index + 1}. ${displayTitle}`));
          console.log(chalk.cyan(`   🔗 ${storyUrl}`));
          if (failure.diffPath) {
            console.log(chalk.gray(`   📸 ${failure.diffPath}`));
          }
          if (failure.error) {
            console.log(chalk.yellow(`   ❌ ${failure.error}`));
          }
        });

        console.log(chalk.dim(`\n💡 Tip: Use --print-urls to see URLs inline with test results`));
      }
    }
  }
}

export default FilteredReporter;
