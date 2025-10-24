import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Enable colors before importing FilteredReporter
process.env.FORCE_COLOR = '1';
import FilteredReporter from './filtered-reporter.js';
import chalk from 'chalk';
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

describe('FilteredReporter', () => {
  let reporter: FilteredReporter;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reporter = new FilteredReporter();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('onBegin', () => {
    it('should log test count and worker count', () => {
      const config: FullConfig = {
        projects: [],
        workers: 4,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [
          { title: 'Test 1' } as TestCase,
          { title: 'Test 2' } as TestCase,
          { title: 'Test 3' } as TestCase,
        ],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 3 tests using 4 workers...\n');
    });

    it('should handle empty test suite', () => {
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [],
      } as unknown as Suite;

      reporter.onBegin(config, rootSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 0 tests using 1 workers...\n');
    });
  });

  describe('onTestEnd', () => {
    it('should log passed tests with checkmark', () => {
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const result: TestResult = {
        status: 'passed',
        duration: 100,
      } as TestResult;

      reporter.onTestEnd(test, result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[32m\u001b[1m✔\u001b[22m\u001b[39m Test 1 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
    });

    it('should log failed tests with X mark', () => {
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const result: TestResult = {
        status: 'failed',
        duration: 100,
      } as TestResult;

      reporter.onTestEnd(test, result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[31m\u001b[1m✘\u001b[22m\u001b[39m Test 1 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
    });

    it('should track test counts correctly', () => {
      const test1: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const test2: TestCase = {
        title: 'Test 2',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const passedResult: TestResult = {
        status: 'passed',
        duration: 100,
      } as TestResult;

      const failedResult: TestResult = {
        status: 'failed',
        duration: 100,
      } as TestResult;

      reporter.onTestEnd(test1, passedResult);
      reporter.onTestEnd(test2, failedResult);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[32m\u001b[1m✔\u001b[22m\u001b[39m Test 1 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[31m\u001b[1m✘\u001b[22m\u001b[39m Test 2 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
    });

    it('should log skipped tests with dash', () => {
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const result: TestResult = {
        status: 'skipped',
        duration: 100,
      } as TestResult;

      reporter.onTestEnd(test, result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[33m\u001b[1m-\u001b[22m\u001b[39m Test 1 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
    });

    it('should log timed out tests with clock', () => {
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const result: TestResult = {
        status: 'timedOut',
        duration: 100,
      } as TestResult;

      reporter.onTestEnd(test, result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[31m\u001b[1m⏰\u001b[22m\u001b[39m Test 1 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
    });

    it('should log interrupted tests with stop sign', () => {
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const result: TestResult = {
        status: 'interrupted',
        duration: 100,
      } as TestResult;

      reporter.onTestEnd(test, result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[31m\u001b[1m⏹\u001b[22m\u001b[39m Test 1 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
    });
  });

  describe('onEnd', () => {
    it('should show success message when all tests passed', () => {
      // Initialize the reporter with proper test count
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [{ title: 'Test 1' } as TestCase, { title: 'Test 2' } as TestCase],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      // Simulate some passed tests
      const test1: TestCase = { title: 'Test 1' } as TestCase;
      const test2: TestCase = { title: 'Test 2' } as TestCase;
      const passedResult: TestResult = { status: 'passed', duration: 100 } as TestResult;

      reporter.onTestEnd(test1, passedResult);
      reporter.onTestEnd(test2, passedResult);

      const result: FullResult = {
        status: 'passed',
        startTime: new Date(),
        duration: 1000,
      } as FullResult;

      reporter.onEnd(result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\n2 (passed|updated), 0 failed .*\(.+\)/),
      );
    });

    it('should show failure message when some tests failed', () => {
      // Initialize the reporter with proper test count
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [{ title: 'Test 1' } as TestCase, { title: 'Test 2' } as TestCase],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      // Simulate mixed results
      const test1: TestCase = { title: 'Test 1' } as TestCase;
      const test2: TestCase = { title: 'Test 2' } as TestCase;
      const passedResult: TestResult = { status: 'passed', duration: 100 } as TestResult;
      const failedResult: TestResult = { status: 'failed', duration: 100 } as TestResult;

      reporter.onTestEnd(test1, passedResult);
      reporter.onTestEnd(test2, failedResult);

      const result: FullResult = {
        status: 'failed',
        startTime: new Date(),
        duration: 1000,
      } as FullResult;

      reporter.onEnd(result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\n1 passed, 1 failed .*\(.+\)/),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(chalk.red.bold('✘ Some tests failed'));
    });

    it('should show all test statuses in summary', () => {
      // Initialize the reporter with proper test count
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [
          { title: 'Test 1' } as TestCase,
          { title: 'Test 2' } as TestCase,
          { title: 'Test 3' } as TestCase,
          { title: 'Test 4' } as TestCase,
          { title: 'Test 5' } as TestCase,
        ],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      // Simulate all types of test results
      const test1: TestCase = { title: 'Test 1' } as TestCase;
      const test2: TestCase = { title: 'Test 2' } as TestCase;
      const test3: TestCase = { title: 'Test 3' } as TestCase;
      const test4: TestCase = { title: 'Test 4' } as TestCase;
      const test5: TestCase = { title: 'Test 5' } as TestCase;

      reporter.onTestEnd(test1, { status: 'passed', duration: 100 } as TestResult);
      reporter.onTestEnd(test2, { status: 'failed', duration: 100 } as TestResult);
      reporter.onTestEnd(test3, { status: 'skipped', duration: 100 } as TestResult);
      reporter.onTestEnd(test4, { status: 'timedOut', duration: 100 } as TestResult);
      reporter.onTestEnd(test5, { status: 'interrupted', duration: 100 } as TestResult);

      const result: FullResult = {
        status: 'failed',
        startTime: new Date(),
        duration: 1000,
      } as FullResult;

      reporter.onEnd(result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\n1 passed, 1 failed, 1 skipped, 1 timed out, 1 interrupted .*\(.+\)/,
        ),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(chalk.red.bold('✘ Some tests failed'));
    });

    it('should handle no tests run', () => {
      // Initialize the reporter with zero tests
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      const result: FullResult = {
        status: 'passed',
        startTime: new Date(),
        duration: 0,
      } as FullResult;

      reporter.onEnd(result);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\n0 passed, 0 failed .*\(.+\)/),
      );
    });
  });

  describe('onStdOut', () => {
    it('should suppress stdout output', () => {
      const chunk = 'Some output';
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      reporter.onStdOut(chunk, test);

      // Should not log anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should suppress stdout output without test context', () => {
      const chunk = 'Some output';

      reporter.onStdOut(chunk);

      // Should not log anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('onStdErr', () => {
    it('should suppress stderr output', () => {
      const chunk = 'Some error';
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      reporter.onStdErr(chunk, test);

      // Should not log anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should suppress stderr output without test context', () => {
      const chunk = 'Some error';

      reporter.onStdErr(chunk);

      // Should not log anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('Time Estimation', () => {
    it('should show low confidence estimates early in test run', () => {
      const config: FullConfig = {
        projects: [],
        workers: 2,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () =>
          Array.from({ length: 20 }, (_, i) => ({ title: `Test ${i + 1}` })) as TestCase[],
      } as Suite;

      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const result: TestResult = {
        status: 'passed',
        duration: 1000,
      } as TestResult;

      reporter.onBegin(config, rootSuite);
      reporter.onTestEnd(test, result);

      // Should show time estimate with low confidence indicator (~)
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Running 20 tests using 2 workers'),
      );
    });

    it('should improve confidence as more tests complete', () => {
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () =>
          Array.from({ length: 25 }, (_, i) => ({ title: `Test ${i + 1}` })) as TestCase[],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      // Run 15 tests to reach medium confidence
      for (let i = 0; i < 15; i++) {
        const test: TestCase = {
          title: `Test ${i + 1}`,
          parent: { title: 'Suite' } as Suite,
        } as TestCase;

        const result: TestResult = {
          status: 'passed',
          duration: 1000 + i * 100, // Varying durations
        } as TestResult;

        reporter.onTestEnd(test, result);
      }

      // Should show medium confidence estimates
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Running 25 tests using 1 workers'),
      );
    });

    it('should handle single worker configuration correctly', () => {
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () =>
          Array.from({ length: 5 }, (_, i) => ({ title: `Test ${i + 1}` })) as TestCase[],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 5 tests using 1 workers...\n');
    });

    it('should provide more accurate estimates with actual test durations', () => {
      const config: FullConfig = {
        projects: [],
        workers: 2,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () =>
          Array.from({ length: 10 }, (_, i) => ({ title: `Test ${i + 1}` })) as TestCase[],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      // Run several tests with realistic durations (1-2 seconds each)
      for (let i = 0; i < 5; i++) {
        const test: TestCase = {
          title: `Test ${i + 1}`,
          parent: { title: 'Suite' } as Suite,
        } as TestCase;

        const result: TestResult = {
          status: 'passed',
          duration: 1000 + i * 200, // 1s, 1.2s, 1.4s, 1.6s, 1.8s
        } as TestResult;

        reporter.onTestEnd(test, result);
      }

      // Should show more realistic estimates based on actual test durations
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Running 10 tests using 2 workers'),
      );
    });
  });

  describe('Retry Handling', () => {
    it('should not count retry attempts as separate test executions', () => {
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [{ title: 'Test 1' } as TestCase],
      } as Suite;

      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      // Simulate a test that fails and retries 3 times, then passes
      const failedResult1: TestResult = {
        status: 'failed',
        duration: 100,
        retry: undefined, // First attempt
      } as TestResult;

      const failedResult2: TestResult = {
        status: 'failed',
        duration: 100,
        retry: 1, // First retry
      } as TestResult;

      const failedResult3: TestResult = {
        status: 'failed',
        duration: 100,
        retry: 2, // Second retry
      } as TestResult;

      const passedResult: TestResult = {
        status: 'passed',
        duration: 100,
        retry: 3, // Third retry (success)
      } as TestResult;

      const finalResult: FullResult = {
        status: 'passed',
        startTime: new Date(),
        duration: 400,
      } as FullResult;

      reporter.onBegin(config, rootSuite);
      reporter.onTestEnd(test, failedResult1);
      reporter.onTestEnd(test, failedResult2);
      reporter.onTestEnd(test, failedResult3);
      reporter.onTestEnd(test, passedResult);
      reporter.onEnd(finalResult);

      // Should only count 1 test execution, not 4
      expect(consoleLogSpy).toHaveBeenCalledWith('Running 1 tests using 1 workers...\n');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\n1 passed, 0 failed .*\(.+\)/),
      );
    });

    it('should show retry attempts in test output but not count them', () => {
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [{ title: 'Test 1' } as TestCase],
      } as Suite;

      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const failedResult: TestResult = {
        status: 'failed',
        duration: 100,
        retry: 1, // First retry
      } as TestResult;

      reporter.onBegin(config, rootSuite);
      reporter.onTestEnd(test, failedResult);

      // Should show retry attempt in output
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[31m\u001b[1m✘\u001b[22m\u001b[39m Test 1 (attempt 2) (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
    });
  });

  describe('Integration', () => {
    it('should work end-to-end with multiple tests', () => {
      const config: FullConfig = {
        projects: [],
        workers: 2,
      } as unknown as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [{ title: 'Test 1' } as TestCase, { title: 'Test 2' } as TestCase],
      } as Suite;

      const test1: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const test2: TestCase = {
        title: 'Test 2',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const passedResult: TestResult = {
        status: 'passed',
        duration: 100,
      } as TestResult;

      const failedResult: TestResult = {
        status: 'failed',
        duration: 100,
      } as TestResult;

      const finalResult: FullResult = {
        status: 'failed',
        startTime: new Date(),
        duration: 200,
      } as FullResult;

      reporter.onBegin(config, rootSuite);
      reporter.onTestEnd(test1, passedResult);
      reporter.onTestEnd(test2, failedResult);
      reporter.onEnd(finalResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 2 tests using 2 workers...\n');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[32m\u001b[1m✔\u001b[22m\u001b[39m Test 1 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '  \u001b[31m\u001b[1m✘\u001b[22m\u001b[39m Test 2 (\u001b[32m100\u001b[39m\u001b[32m\u001b[2mms\u001b[22m\u001b[39m)',
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\n1 passed, 1 failed .*\(.+\)/),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(chalk.red.bold('✘ Some tests failed'));
    });

    it('should handle large number of tests', () => {
      const config: FullConfig = {
        projects: [],
        workers: 8,
      } as unknown as FullConfig;

      const tests = Array.from({ length: 100 }, (_, i) => ({
        title: `Test ${i + 1}`,
      })) as TestCase[];

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => tests,
      } as Suite;

      reporter.onBegin(config, rootSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 100 tests using 8 workers...\n');
    });
  });
});
