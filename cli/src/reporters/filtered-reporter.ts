import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import ora from 'ora';

type Counts = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  timedOut: number;
  interrupted: number;
};

export default class FilteredReporter implements Reporter {
  private readonly showProgress: boolean;
  private readonly quiet: boolean;
  private startTime = Date.now();
  private counts: Counts = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    interrupted: 0,
  };
  private storiesPlanned: number | undefined;
  private snapshotsMissing: number | undefined;
  private spinners: Map<string, ReturnType<typeof ora>> = new Map();
  private testStartTimes: Map<string, number> = new Map();
  private progressSpinner: ReturnType<typeof ora> | undefined;
  private completedTests = 0;

  constructor(options?: { progress?: boolean; quiet?: boolean }) {
    this.showProgress = options?.progress ?? true;
    this.quiet = options?.quiet ?? false;
  }

  private getProgressText(): string {
    if (!this.storiesPlanned || this.storiesPlanned === 0) return '';

    const percent = Math.round((this.completedTests / this.storiesPlanned) * 100);
    const elapsed = Date.now() - this.startTime;
    const avgTimePerTest = elapsed / Math.max(this.completedTests, 1);
    const remaining = (this.storiesPlanned - this.completedTests) * avgTimePerTest;
    const remainingSeconds = Math.round(remaining / 1000);

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    return `${this.completedTests} of ${this.storiesPlanned} (${percent}%) ≈${timeStr} remaining`;
  }

  onBegin(config: FullConfig, suite: Suite) {
    // Prefer story count from runtime file if provided
    try {
      const runtimePath = process.env.SVR_RUNTIME_OPTIONS;
      if (runtimePath) {
        const raw = fs.readFileSync(runtimePath, 'utf8');
        const data = JSON.parse(raw) as {
          stories?: Array<{ snapshotRelPath?: string }>;
          config?: { snapshotPath?: string };
        };
        const storiesLen = Array.isArray(data?.stories) ? data.stories.length : undefined;
        if (typeof storiesLen === 'number' && storiesLen > 0) {
          this.storiesPlanned = storiesLen;
          this.counts.total = storiesLen;
        }
        // If update mode, show a more accurate planned message
        if (!this.quiet) {
          const isUpdate = process.env.SVR_UPDATE === '1';
          if (isUpdate && Array.isArray(data?.stories) && data?.config?.snapshotPath) {
            const snapshotRoot = path.resolve(
              process.env.SVR_CWD || process.cwd(),
              data.config.snapshotPath,
            );
            let missing = 0;
            for (const s of data.stories) {
              const rel = s.snapshotRelPath;
              if (!rel) continue;
              const expected = path.join(snapshotRoot, rel);
              if (!fs.existsSync(expected)) missing += 1;
            }
            this.snapshotsMissing = missing;
            const plannedMsg =
              process.env.SVR_MISSING_ONLY === '1'
                ? `Updating ${missing} missing snapshot${missing === 1 ? '' : 's'}`
                : `Updating ${this.storiesPlanned ?? 0} snapshot${(this.storiesPlanned ?? 0) === 1 ? '' : 's'}`;
            process.stdout.write(`${plannedMsg}\n`);
          }
        }
      }
    } catch {
      /* ignore */
    }
    if (!this.storiesPlanned) this.counts.total = suite.allTests().length;
    if (!this.quiet) {
      const planned = this.storiesPlanned ?? this.counts.total;
      if (process.env.SVR_UPDATE !== '1') {
        process.stdout.write(`Running ${planned} stories\n`);
      }
      // Initialize progress spinner for regular runs
      if (process.env.SVR_UPDATE !== '1' && this.storiesPlanned && this.storiesPlanned > 0) {
        this.progressSpinner = ora({
          text: this.getProgressText(),
          spinner: 'dots',
          interval: 100,
        }).start();
      }
    }
  }

  onTestBegin(test: TestCase) {
    if (this.quiet) return;

    // Stop progress spinner and show current progress before starting test
    if (this.progressSpinner) {
      this.progressSpinner.stop();
      process.stdout.write(`${this.getProgressText()}\n`);
    }

    const testId = test.title;
    this.testStartTimes.set(testId, Date.now());
    const spinner = ora(`Running ${testId}`).start();
    this.spinners.set(testId, spinner);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'passed') this.counts.passed += 1;
    else if (result.status === 'failed') this.counts.failed += 1;
    else if (result.status === 'skipped') this.counts.skipped += 1;
    else if (result.status === 'timedOut') this.counts.timedOut += 1;
    else if (result.status === 'interrupted') this.counts.interrupted += 1;

    this.completedTests += 1;

    const testId = test.title;
    const spinner = this.spinners.get(testId);
    if (spinner && !this.quiet) {
      const startTime = this.testStartTimes.get(testId) || Date.now();
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      if (result.status === 'passed') {
        spinner.succeed(`${testId} (${duration}s)`);
      } else if (result.status === 'failed') {
        spinner.fail(`${testId} (${duration}s)`);
      } else {
        spinner.warn(`${testId} (${duration}s)`);
      }
      this.spinners.delete(testId);
      this.testStartTimes.delete(testId);
    }

    // Update progress spinner
    if (this.progressSpinner && !this.quiet) {
      this.progressSpinner.text = this.getProgressText();
    }
  }

  onEnd(): void {
    const dur = Date.now() - this.startTime;
    if (!this.quiet) {
      if (this.progressSpinner) {
        this.progressSpinner.stop();
      }
      process.stdout.write('\n');
    }
    const { total, passed, failed, skipped, timedOut, interrupted } = this.counts;

    if (process.env.SVR_UPDATE === '1') {
      const count = this.snapshotsMissing ?? total;
      process.stdout.write(
        `Updated ${count} snapshot${count === 1 ? '' : 's'} in ${(dur / 1000).toFixed(1)}s\n`,
      );
      return;
    }

    // Show summary for regular runs
    process.stdout.write(
      `Summary: ${passed}/${total} passed, ${failed} failed, ${skipped} skipped, ${timedOut} timed out, ${interrupted} interrupted in ${(dur / 1000).toFixed(1)}s\n`,
    );
  }
}
