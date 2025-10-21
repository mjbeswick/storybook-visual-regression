import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import chalk from 'chalk';
import ora from 'ora';
import type { Ora } from 'ora';

export type StorybookTestResult = {
  storyId: string;
  title: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
  duration: number;
  error?: string;
  diffImagePath?: string;
  expectedImagePath?: string;
  actualImagePath?: string;
};

export default class StorybookReporter implements Reporter {
  private startTime = 0;
  private tests: StorybookTestResult[] = [];
  private totalTests = 0;
  private completedTests = 0;
  private workers = 1;
  private spinner: Ora | null = null;
  private recentTestDurations: number[] = [];
  private smoothedAverage = 0;

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = Math.floor(s / 60);
    const rs = Math.round(s % 60);
    return `${m}m ${rs}s`;
  }

  private calculateTimeEstimate(): { etaMs: number; confidence: 'low' | 'medium' | 'high' } {
    const remaining = Math.max(0, this.totalTests - this.completedTests);
    if (remaining === 0) return { etaMs: 0, confidence: 'high' };

    let avgTestDuration: number;
    let confidence: 'low' | 'medium' | 'high';

    if (this.recentTestDurations.length >= 3) {
      const recentSum = this.recentTestDurations.reduce((sum, d) => sum + d, 0);
      avgTestDuration = recentSum / this.recentTestDurations.length;
      confidence = this.recentTestDurations.length >= 10 ? 'high' : 'medium';
    } else if (this.completedTests >= 3) {
      const elapsedMs = Math.max(1, Date.now() - this.startTime);
      const wallClockTimePerTest = elapsedMs / this.completedTests;
      const effectiveWorkers = Math.min(this.workers, this.completedTests);
      avgTestDuration = wallClockTimePerTest * effectiveWorkers;
      confidence = 'low';
    } else {
      const elapsedMs = Math.max(1, Date.now() - this.startTime);
      avgTestDuration = elapsedMs / Math.max(1, this.completedTests);
      confidence = 'low';
    }

    // Apply smoothing
    if (this.smoothedAverage === 0) {
      this.smoothedAverage = avgTestDuration;
    } else {
      const alpha = Math.min(0.4, 3 / (this.completedTests + 1));
      this.smoothedAverage = alpha * avgTestDuration + (1 - alpha) * this.smoothedAverage;
    }

    // Calculate ETA
    let etaMs: number;
    if (this.workers === 1) {
      etaMs = this.smoothedAverage * remaining;
    } else {
      const efficiencyFactor = Math.min(0.75, 0.4 + (0.25 * Math.log(this.workers)) / Math.log(2));
      const effectiveWorkers = this.workers * efficiencyFactor;
      const remainingWork = this.smoothedAverage * remaining;
      etaMs = (remainingWork / effectiveWorkers) * 1.2; // Add buffer
    }

    return { etaMs, confidence };
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startTime = Date.now();
    this.totalTests = this.countTests(suite);
    this.completedTests = 0;
    this.workers = _config.workers || 1;

    // Output header line
    console.log('');
    console.log(`Running ${this.totalTests} tests using ${this.workers} workers...`);
    console.log('');

    // Start spinner with initial progress
    this.spinner = ora({
      text: chalk.gray(`0 ${chalk.dim('of')} ${this.totalTests} ${chalk.dim('estimating…')}`),
      isEnabled: true,
    }).start();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Extract story information from test title
    // Test titles are in format: "Story Title / Story Name [story-id]"
    const fullTitle = test.title;

    // Extract story ID from brackets if present
    const storyIdMatch = fullTitle.match(/\[([^\]]+)\]/);
    const storyId = storyIdMatch ? storyIdMatch[1] : fullTitle.toLowerCase().replace(/\s+/g, '-');

    // Extract title and name from the part before brackets
    const titleWithoutBrackets = fullTitle.replace(/\s*\[[^\]]+\]\s*$/, '');
    const titleParts = titleWithoutBrackets.split(' / ');
    const title = titleParts.slice(0, -1).join(' / ') || titleWithoutBrackets;
    const name = titleParts[titleParts.length - 1] || titleWithoutBrackets;

    // Extract image paths from attachments
    let diffImagePath: string | undefined;
    let expectedImagePath: string | undefined;
    let actualImagePath: string | undefined;

    for (const attachment of result.attachments) {
      if (attachment.name.includes('-diff') && attachment.path) {
        diffImagePath = attachment.path;
      } else if (attachment.name.includes('-expected') && attachment.path) {
        expectedImagePath = attachment.path;
      } else if (attachment.name.includes('-actual') && attachment.path) {
        actualImagePath = attachment.path;
      }
    }

    const testResult: StorybookTestResult = {
      storyId,
      title,
      name,
      status: result.status,
      duration: result.duration,
      error: result.error?.message,
      diffImagePath,
      expectedImagePath,
      actualImagePath,
    };

    this.tests.push(testResult);
    this.completedTests++;

    // Track test duration for estimation
    this.recentTestDurations.push(result.duration);
    if (this.recentTestDurations.length > 20) {
      this.recentTestDurations.shift(); // Keep only recent 20 durations
    }

    // Calculate progress and time estimate
    const { etaMs, confidence } = this.calculateTimeEstimate();
    const remaining = this.totalTests - this.completedTests;

    // Format test duration with color
    const rawDuration = result.duration;
    const testDuration = this.formatDuration(rawDuration);
    const durationText = ` ${testDuration.replace(
      /(\d+(?:\.\d+)?)([a-zA-Z]+)/g,
      (match, number, unit) => {
        const baseColor =
          rawDuration > 10000 ? chalk.red : rawDuration > 5000 ? chalk.yellow : chalk.green;
        return `${baseColor(number)}${baseColor.dim(unit)}`;
      },
    )}`;

    // Create progress label
    const percentage = Math.round((this.completedTests / this.totalTests) * 100);
    let progressLabel = `${chalk.cyan(String(this.completedTests))} ${chalk.dim('of')} ${chalk.cyan(String(this.totalTests))} ${chalk.gray(`(${percentage}%)`)}`;

    // Add time estimate
    if (remaining > 0) {
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

    // Update spinner
    if (this.spinner) {
      this.spinner.text = progressLabel;
    }

    // Output test result with proper formatting
    const statusSymbol = this.getStatusSymbol(result.status);
    const outputCore = `${title} ❯ ${name}`;

    if (this.spinner) {
      this.spinner.stop();
      this.spinner.clear();
    }

    console.log(`  ${statusSymbol} ${outputCore}${durationText}`);

    if (this.spinner && remaining > 0) {
      this.spinner.start(progressLabel);
    }
  }

  onEnd(_result: FullResult): void {
    // Stop spinner
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }

    const duration = Date.now() - this.startTime;
    const passed = this.tests.filter((t) => t.status === 'passed').length;
    const failed = this.tests.filter((t) => t.status === 'failed').length;
    const skipped = this.tests.filter(
      (t) => t.status === 'skipped' || t.status === 'interrupted',
    ).length;
    const timedOut = this.tests.filter((t) => t.status === 'timedOut').length;

    // Format duration like filtered reporter
    const formattedDuration = this.formatDuration(duration);

    // Summary line with proper formatting
    console.log(
      `\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}${timedOut > 0 ? `, ${timedOut} timed out` : ''} ${chalk.gray(`(${formattedDuration})`)}`,
    );

    // Status message with colors
    if (failed > 0 || timedOut > 0) {
      console.log(chalk.red.bold('✘ Some tests failed'));
    } else {
      console.log(chalk.green.bold('✓ All tests passed'));
    }
  }

  private getStatusSymbol(status: string): string {
    switch (status) {
      case 'passed':
        return chalk.green.bold('✔');
      case 'failed':
        return chalk.red.bold('✘');
      case 'skipped':
        return chalk.yellow.bold('⏹');
      case 'timedOut':
        return chalk.red.bold('⏱');
      case 'interrupted':
        return chalk.yellow.bold('⏹');
      default:
        return chalk.gray('?');
    }
  }

  private countTests(suite: Suite): number {
    let count = 0;
    for (const child of suite.suites) {
      count += this.countTests(child);
    }
    for (const _test of suite.tests) {
      count++;
    }
    return count;
  }
}
