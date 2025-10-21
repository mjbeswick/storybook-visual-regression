import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

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

export type StorybookOutput = {
  type: 'storybook-result';
  status: 'passed' | 'failed' | 'timedout' | 'interrupted';
  startTime: number;
  duration: number;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  tests: StorybookTestResult[];
};

export default class StorybookReporter implements Reporter {
  private startTime = 0;
  private tests: StorybookTestResult[] = [];
  private totalTests = 0;
  private completedTests = 0;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startTime = Date.now();
    this.totalTests = this.countTests(suite);
    this.completedTests = 0;

    // Output test count and progress info
    console.log(
      JSON.stringify({
        type: 'test-progress',
        display: `Running ${this.totalTests} tests using ${_config.workers || 1} workers`,
        total: this.totalTests,
        workers: _config.workers || 1,
      }),
    );
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

    // Output individual test result immediately for real-time updates
    // Format optimized for addon log panel to match terminal output
    const statusSymbol = this.getStatusSymbol(result.status);
    const durationText = `${(result.duration / 1000).toFixed(1)}s`;
    const _progress = `${this.completedTests}/${this.totalTests}`;

    console.log(
      JSON.stringify({
        type: 'test-result',
        test: testResult,
        display: `  ${statusSymbol} ${title} ❯ ${name} ${durationText}`,
        progress: this.completedTests,
        total: this.totalTests,
      }),
    );
  }

  onEnd(result: FullResult): void {
    const duration = Date.now() - this.startTime;
    const passed = this.tests.filter((t) => t.status === 'passed').length;
    const failed = this.tests.filter((t) => t.status === 'failed').length;
    const skipped = this.tests.filter((t) => t.status === 'skipped').length;

    // Output clean summary for addon to match terminal format
    const durationSeconds = (duration / 1000).toFixed(1);
    const summary = `${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} interrupted` : ''} (${durationSeconds}s)`;

    console.log(
      JSON.stringify({
        type: 'test-summary',
        summary,
        passed,
        failed,
        skipped,
        total: this.tests.length,
        duration,
        status: result.status,
      }),
    );
  }

  private getStatusSymbol(status: string): string {
    switch (status) {
      case 'passed':
        return '✔';
      case 'failed':
        return '✗';
      case 'skipped':
        return '⏹';
      case 'timedOut':
        return '⏱';
      case 'interrupted':
        return '⏹';
      default:
        return '?';
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
