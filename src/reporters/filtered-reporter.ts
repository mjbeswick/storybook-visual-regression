import {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

class FilteredReporter implements Reporter {
  private failures: TestCase[] = [];
  private passed = 0;
  private failed = 0;

  onBegin(config: FullConfig, suite: Suite) {
    console.log(`Running ${suite.allTests().length} tests using ${config.workers} workers\n`);
  }

  onStdOut(chunk: string | Buffer, test?: TestCase, result?: TestResult) {
    // Suppress stdout
  }

  onStdErr(chunk: string | Buffer, test?: TestCase, result?: TestResult) {
    // Suppress stderr
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'failed') {
      this.failures.push(test);
      this.failed++;
      console.log(`  ✘   ${test.title}`);
    } else if (result.status === 'passed') {
      this.passed++;
      console.log(`  ✓   ${test.title}`);
    }
  }

  onEnd(result: FullResult) {
    console.log(`\n${this.passed} passed, ${this.failed} failed`);

    if (result.status === 'passed') {
      console.log('✓ All tests passed');
    } else {
      console.log('✘ Some tests failed');
    }
  }
}

export default FilteredReporter;
