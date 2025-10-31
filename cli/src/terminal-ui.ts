/*
 * Simplified terminal UI for visual regression testing
 * Shows running tests and updates them when they complete
 */
import chalk from 'chalk';

interface TestStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'pass' | 'fail';
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  duration: number;
  storyUrl?: string;
  diffPath?: string;
}

export class TerminalUI {
  private tests: Map<string, TestStatus> = new Map();
  private totalTests = 0;
  private isDestroyed = false;
  private lastDisplayedLines = 0; // Track how many lines we've displayed
  private uiCreationTime = Date.now();
  private actualStartTime: number | null = null; // When first test actually starts
  private showProgress = false;

  constructor(totalTests: number, showProgress = false) {
    this.totalTests = totalTests;
    this.showProgress = showProgress;
  }

  static isSupported(): boolean {
    // Check if we're in a TTY and not in CI, or if forced for testing
    return (process.stdout.isTTY || !!process.env.FORCE_TUI) && !process.env.CI;
  }

  startTest(storyId: string, name: string) {
    if (this.isDestroyed) return;

    // Set actual start time when first test begins
    if (this.actualStartTime === null) {
      this.actualStartTime = Date.now();
    }

    const test: TestStatus = {
      id: storyId,
      name: name || storyId,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      duration: 0
    };

    this.tests.set(storyId, test);
    this.redraw();
  }

  finishTest(storyId: string, success: boolean, error?: string, storyUrl?: string) {
    if (this.isDestroyed) return;

    const test = this.tests.get(storyId);
    if (!test) return;

    test.status = success ? 'pass' : 'fail';
    test.endedAt = Date.now();
    test.error = success ? null : (error || 'Unknown error');
    test.duration = test.endedAt - (test.startedAt || test.endedAt);

    // Store additional failure info for display
    if (!success && storyUrl) {
      test.storyUrl = storyUrl;
      // Extract diff path from error message for visual regression failures
      if (error) {
        const diffMatch = error.match(/diff: ([^\)]+)/);
        if (diffMatch) {
          test.diffPath = diffMatch[1];
        }
      }
    }

    this.redraw();
  }

  private redraw() {
    if (this.isDestroyed) return;

    // In TTY environments, clear and redraw the status
    if (process.stdout.isTTY || !!process.env.FORCE_TUI) {
      // Clear the previous display by moving cursor up and clearing
      if (this.lastDisplayedLines > 0) {
        process.stdout.write(`\x1b[${this.lastDisplayedLines}A\x1b[0J`);
      }
    }

    // Collect all current tests in the order they were started
    const allTests = Array.from(this.tests.values()).sort((a, b) => {
      const aTime = a.startedAt || 0;
      const bTime = b.startedAt || 0;
      return aTime - bTime;
    });

    let linesPrinted = 0;

    // Show only completed tests
    for (const test of allTests) {
      if (test.status === 'pass') {
        const duration = (test.duration / 1000).toFixed(1);
        console.log(`${chalk.green('✓')} ${test.name} ${chalk.dim(`(${duration}s)`)}`);
      } else if (test.status === 'fail') {
        const duration = (test.duration / 1000).toFixed(1);
        console.log(`${chalk.red('✗')} ${test.name} ${chalk.dim(`(${duration}s)`)}`);
        if (test.storyUrl) {
          console.log(`  ${chalk.dim(test.storyUrl)}`);
        }
        if (test.diffPath) {
          console.log(`  ${chalk.dim(test.diffPath)}`);
        }
      }
      if (test.status === 'pass' || test.status === 'fail') {
        linesPrinted++;
      }
    }

    // Add status row with progress, ETA, and stories per minute (only when summary is enabled)
    if (this.showProgress) {
      const completedTests = allTests.filter(t => t.status === 'pass' || t.status === 'fail');
      const completed = completedTests.length;
      const total = this.totalTests;
      const percentage = Math.round((completed / total) * 100);

      if (completed > 0) {
        // Calculate stories per minute using actual test start time
        const elapsedMs = Date.now() - (this.actualStartTime || this.uiCreationTime);
        const elapsedMinutes = elapsedMs / (1000 * 60);

        // Bound stories per minute to realistic values (1-1000 stories per minute)
        const rawStoriesPerMinute = completed / Math.max(elapsedMinutes, 0.01);
        const storiesPerMinute = Math.round(Math.max(1, Math.min(rawStoriesPerMinute, 1000)));

        // Calculate ETA using stories per minute rate
        const remainingTests = total - completed;
        const etaMinutesCalc = remainingTests / Math.max(storiesPerMinute, 1); // Stories per minute
        const etaSeconds = Math.round(etaMinutesCalc * 60); // Convert to seconds

        // Format ETA with bounds checking
        const boundedEtaSeconds = Math.min(etaSeconds, 3600); // Cap at 1 hour
        const etaMinutesDisplay = Math.floor(boundedEtaSeconds / 60);
        const etaDisplay = boundedEtaSeconds >= 60
          ? `${etaMinutesDisplay}m ${boundedEtaSeconds % 60}s`
          : boundedEtaSeconds > 0
            ? `${boundedEtaSeconds}s`
            : '0s';

        console.log(chalk.dim(`Progress: ${completed}/${total} (${percentage}%) • ETA: ${etaDisplay} • ${storiesPerMinute}/m`));
        linesPrinted++;
      }
    }

    this.lastDisplayedLines = linesPrinted;
  }

  log(message: string) {
    if (this.isDestroyed) return;
    console.log(message);
  }

  error(message: string) {
    if (this.isDestroyed) return;
    console.error(chalk.red(message));
  }

  updateProgress(completed: number, total: number, elapsedMs: number) {
    // Not used in simplified UI
  }

  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    // No cleanup needed for simplified UI
  }
}
