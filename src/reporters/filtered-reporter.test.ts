import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import FilteredReporter from './filtered-reporter.js';
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
      } as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [
          { title: 'Test 1' } as TestCase,
          { title: 'Test 2' } as TestCase,
          { title: 'Test 3' } as TestCase,
        ],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 3 tests using 4 workers\n');
    });

    it('should handle empty test suite', () => {
      const config: FullConfig = {
        projects: [],
        workers: 1,
      } as FullConfig;

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => [],
      } as Suite;

      reporter.onBegin(config, rootSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 0 tests using 1 workers\n');
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

      expect(consoleLogSpy).toHaveBeenCalledWith('  ✔ Test 1 100ms');
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

      expect(consoleLogSpy).toHaveBeenCalledWith('  ✘ Test 1 100ms');
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

      expect(consoleLogSpy).toHaveBeenCalledWith('  ✔ Test 1 100ms');
      expect(consoleLogSpy).toHaveBeenCalledWith('  ✘ Test 2 100ms');
    });

    it('should ignore skipped tests', () => {
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const result: TestResult = {
        status: 'skipped',
        duration: 100,
      } as TestResult;

      reporter.onTestEnd(test, result);

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should ignore timed out tests', () => {
      const test: TestCase = {
        title: 'Test 1',
        parent: { title: 'Suite' } as Suite,
      } as TestCase;

      const result: TestResult = {
        status: 'timedOut',
        duration: 100,
      } as TestResult;

      reporter.onTestEnd(test, result);

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('onEnd', () => {
    it('should show success message when all tests passed', () => {
      const result: FullResult = {
        status: 'passed',
        startTime: Date.now(),
        duration: 1000,
      } as FullResult;

      reporter.onEnd(result);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n0 passed, 0 failed');
    });

    it('should show failure message when some tests failed', () => {
      const result: FullResult = {
        status: 'failed',
        startTime: Date.now(),
        duration: 1000,
      } as FullResult;

      reporter.onEnd(result);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n0 passed, 0 failed');
      expect(consoleLogSpy).toHaveBeenCalledWith('✘ Some tests failed');
    });

    it('should handle mixed results', () => {
      const result: FullResult = {
        status: 'passed',
        startTime: Date.now(),
        duration: 1000,
      } as FullResult;

      reporter.onEnd(result);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n0 passed, 0 failed');
    });

    it('should handle no tests run', () => {
      const result: FullResult = {
        status: 'passed',
        startTime: Date.now(),
        duration: 0,
      } as FullResult;

      reporter.onEnd(result);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n0 passed, 0 failed');
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

  describe('Integration', () => {
    it('should work end-to-end with multiple tests', () => {
      const config: FullConfig = {
        projects: [],
        workers: 2,
      } as FullConfig;

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
        startTime: Date.now(),
        duration: 200,
      } as FullResult;

      reporter.onBegin(config, rootSuite);
      reporter.onTestEnd(test1, passedResult);
      reporter.onTestEnd(test2, failedResult);
      reporter.onEnd(finalResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 2 tests using 2 workers\n');
      expect(consoleLogSpy).toHaveBeenCalledWith('  ✔ Test 1 100ms');
      expect(consoleLogSpy).toHaveBeenCalledWith('  ✘ Test 2 100ms');
      expect(consoleLogSpy).toHaveBeenCalledWith('\n1 passed, 1 failed');
      expect(consoleLogSpy).toHaveBeenCalledWith('✘ Some tests failed');
    });

    it('should handle large number of tests', () => {
      const config: FullConfig = {
        projects: [],
        workers: 8,
      } as FullConfig;

      const tests = Array.from({ length: 100 }, (_, i) => ({
        title: `Test ${i + 1}`,
      })) as TestCase[];

      const rootSuite: Suite = {
        title: 'Root',
        allTests: () => tests,
      } as Suite;

      reporter.onBegin(config, rootSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 100 tests using 8 workers\n');
    });
  });
});
