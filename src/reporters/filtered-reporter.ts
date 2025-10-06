import {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import chalk from 'chalk';

class FilteredReporter implements Reporter {
  private failures: TestCase[] = [];
  private passed = 0;
  private failed = 0;

  onBegin(config: FullConfig, suite: Suite): void {
    const total = suite.allTests().length;
    console.log(
      `${chalk.bold('🚀 Running')} ${chalk.cyan(String(total))} ${chalk.gray('tests using')} ${chalk.cyan(String(config.workers))} ${chalk.gray('workers')}\n`,
    );
  }

  onStdOut(_chunk: string | Buffer, _test?: TestCase, _result?: TestResult): void {
    // Suppress stdout
  }

  onStdErr(_chunk: string | Buffer, _test?: TestCase, _result?: TestResult): void {
    // Suppress stderr
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'failed') {
      this.failures.push(test);
      this.failed++;
      console.log(`  ${chalk.red('✗')}   ${chalk.red(test.title)}`);
    } else if (result.status === 'passed') {
      this.passed++;
      console.log(`  ${chalk.green('✓')}   ${chalk.white(test.title)}`);
    }
  }

  onEnd(result: FullResult): void {
    console.log(
      `\n${chalk.green(String(this.passed))} ${chalk.gray('passed')}, ${chalk.red(String(this.failed))} ${chalk.gray('failed')}`,
    );

    if (result.status === 'passed') {
      console.log(`${chalk.green('✓')} ${chalk.bold('All tests passed')}`);
    } else {
      console.log(`${chalk.red('✗')} ${chalk.bold('Some tests failed')}`);
    }
  }
}

export default FilteredReporter;
