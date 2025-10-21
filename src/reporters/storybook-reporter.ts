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

export default class StorybookReporter implements Reporter {
  private startTime = 0;
  private tests: StorybookTestResult[] = [];
  private totalTests = 0;
  private completedTests = 0;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startTime = Date.now();
    this.totalTests = this.countTests(suite);
    this.completedTests = 0;

    // Output blank line and progress info to match terminal
    console.log('');
    console.log(`Running ${this.totalTests} tests using ${_config.workers || 1} workers`);
    console.log('');
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

    // Output individual test result to match terminal format exactly
    const statusSymbol = this.getStatusSymbol(result.status);
    const durationText = `${(result.duration / 1000).toFixed(1)}s`;

    console.log(`  ${statusSymbol} ${title} › ${name} ${durationText}`);
  }

  onEnd(result: FullResult): void {
    const duration = Date.now() - this.startTime;
    const passed = this.tests.filter((t) => t.status === 'passed').length;
    const failed = this.tests.filter((t) => t.status === 'failed').length;
    const skipped = this.tests.filter(
      (t) => t.status === 'skipped' || t.status === 'interrupted',
    ).length;

    // Output summary to match terminal format exactly
    const durationSeconds = (duration / 1000).toFixed(1);
    const summary = `${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} interrupted` : ''} (${durationSeconds}s)`;

    console.log('');
    console.log(summary);

    // Add final status line if tests failed
    if (failed > 0) {
      console.log('✘ Some tests failed');
    }
  }

  private getStatusSymbol(status: string): string {
    switch (status) {
      case 'passed':
        return '✔';
      case 'failed':
        return '✘';
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
