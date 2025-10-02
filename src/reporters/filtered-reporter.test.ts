import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import FilteredReporter from './filtered-reporter.js';
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';

describe('FilteredReporter', () => {
  let reporter: FilteredReporter;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleStdoutSpy: ReturnType<typeof vi.spyOn>;
  let consoleStderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reporter = new FilteredReporter();
    
    // Mock console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleStdoutSpy = vi.spyOn(console, 'stdout', 'get').mockReturnValue({
      write: vi.fn(),
    } as any);
    consoleStderrSpy = vi.spyOn(console, 'stderr', 'get').mockReturnValue({
      write: vi.fn(),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('onBegin', () => {
    it('should log test count and worker count', () => {
      const mockConfig: FullConfig = {
        workers: 4,
      } as FullConfig;

      const mockSuite: Suite = {
        allTests: () => [
          { title: 'test1' } as TestCase,
          { title: 'test2' } as TestCase,
          { title: 'test3' } as TestCase,
        ],
      } as Suite;

      reporter.onBegin(mockConfig, mockSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 3 tests using 4 workers\n');
    });

    it('should handle empty test suite', () => {
      const mockConfig: FullConfig = {
        workers: 1,
      } as FullConfig;

      const mockSuite: Suite = {
        allTests: () => [],
      } as Suite;

      reporter.onBegin(mockConfig, mockSuite);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 0 tests using 1 workers\n');
    });
  });

  describe('onTestEnd', () => {
    it('should log passed tests with checkmark', () => {
      const mockTest: TestCase = {
        title: 'example-button--primary',
      } as TestCase;

      const mockResult: TestResult = {
        status: 'passed',
        duration: 1500,
      } as TestResult;

      reporter.onTestEnd(mockTest, mockResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('  ✓   example-button--primary');
    });

    it('should log failed tests with X mark', () => {
      const mockTest: TestCase = {
        title: 'example-card--default',
      } as TestCase;

      const mockResult: TestResult = {
        status: 'failed',
        duration: 2000,
      } as TestResult;

      reporter.onTestEnd(mockTest, mockResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('  ✘   example-card--default');
    });

    it('should track test counts correctly', () => {
      const passedTest: TestCase = { title: 'test1' } as TestCase;
      const failedTest: TestCase = { title: 'test2' } as TestCase;
      const passedResult: TestResult = { status: 'passed' } as TestResult;
      const failedResult: TestResult = { status: 'failed' } as TestResult;

      reporter.onTestEnd(passedTest, passedResult);
      reporter.onTestEnd(failedTest, failedResult);

      // Check internal state by calling onEnd
      const mockResult: FullResult = {
        status: 'failed',
        duration: 5000,
      } as FullResult;

      reporter.onEnd(mockResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n1 passed, 1 failed');
    });

    it('should ignore skipped tests', () => {
      const mockTest: TestCase = {
        title: 'skipped-test',
      } as TestCase;

      const mockResult: TestResult = {
        status: 'skipped',
        duration: 0,
      } as TestResult;

      reporter.onTestEnd(mockTest, mockResult);

      // Should not log anything for skipped tests
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should ignore timed out tests', () => {
      const mockTest: TestCase = {
        title: 'timeout-test',
      } as TestCase;

      const mockResult: TestResult = {
        status: 'timedOut',
        duration: 30000,
      } as TestResult;

      reporter.onTestEnd(mockTest, mockResult);

      // Should not log anything for timed out tests
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('onEnd', () => {
    it('should show success message when all tests passed', () => {
      // Set up some passed tests
      const passedTest: TestCase = { title: 'test1' } as TestCase;
      const passedResult: TestResult = { status: 'passed' } as TestResult;
      reporter.onTestEnd(passedTest, passedResult);

      const mockResult: FullResult = {
        status: 'passed',
        duration: 5000,
      } as FullResult;

      reporter.onEnd(mockResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n1 passed, 0 failed');
      expect(consoleLogSpy).toHaveBeenCalledWith('✓ All tests passed');
    });

    it('should show failure message when some tests failed', () => {
      // Set up some failed tests
      const failedTest: TestCase = { title: 'test1' } as TestCase;
      const failedResult: TestResult = { status: 'failed' } as TestResult;
      reporter.onTestEnd(failedTest, failedResult);

      const mockResult: FullResult = {
        status: 'failed',
        duration: 5000,
      } as FullResult;

      reporter.onEnd(mockResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n0 passed, 1 failed');
      expect(consoleLogSpy).toHaveBeenCalledWith('✘ Some tests failed');
    });

    it('should handle mixed results', () => {
      // Set up mixed results
      const passedTest: TestCase = { title: 'passed-test' } as TestCase;
      const failedTest: TestCase = { title: 'failed-test' } as TestCase;
      const passedResult: TestResult = { status: 'passed' } as TestResult;
      const failedResult: TestResult = { status: 'failed' } as TestResult;

      reporter.onTestEnd(passedTest, passedResult);
      reporter.onTestEnd(failedTest, failedResult);

      const mockResult: FullResult = {
        status: 'failed',
        duration: 5000,
      } as FullResult;

      reporter.onEnd(mockResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n1 passed, 1 failed');
      expect(consoleLogSpy).toHaveBeenCalledWith('✘ Some tests failed');
    });

    it('should handle no tests run', () => {
      const mockResult: FullResult = {
        status: 'passed',
        duration: 0,
      } as FullResult;

      reporter.onEnd(mockResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('\n0 passed, 0 failed');
      expect(consoleLogSpy).toHaveBeenCalledWith('✓ All tests passed');
    });
  });

  describe('onStdOut', () => {
    it('should suppress stdout output', () => {
      const mockTest: TestCase = { title: 'test1' } as TestCase;
      const mockResult: TestResult = { status: 'passed' } as TestResult;

      reporter.onStdOut('Some stdout output', mockTest, mockResult);

      // Should not output anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should suppress stdout output without test context', () => {
      reporter.onStdOut('Some stdout output');

      // Should not output anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('onStdErr', () => {
    it('should suppress stderr output', () => {
      const mockTest: TestCase = { title: 'test1' } as TestCase;
      const mockResult: TestResult = { status: 'failed' } as TestResult;

      reporter.onStdErr('Some stderr output', mockTest, mockResult);

      // Should not output anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should suppress stderr output without test context', () => {
      reporter.onStdErr('Some stderr output');

      // Should not output anything
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('Integration', () => {
    it('should work end-to-end with multiple tests', () => {
      const mockConfig: FullConfig = {
        workers: 2,
      } as FullConfig;

      const mockSuite: Suite = {
        allTests: () => [
          { title: 'test1' } as TestCase,
          { title: 'test2' } as TestCase,
          { title: 'test3' } as TestCase,
        ],
      } as Suite;

      // Begin
      reporter.onBegin(mockConfig, mockSuite);

      // Test results
      reporter.onTestEnd({ title: 'test1' } as TestCase, { status: 'passed' } as TestResult);
      reporter.onTestEnd({ title: 'test2' } as TestCase, { status: 'failed' } as TestResult);
      reporter.onTestEnd({ title: 'test3' } as TestCase, { status: 'passed' } as TestResult);

      // End
      const mockResult: FullResult = {
        status: 'failed',
        duration: 10000,
      } as FullResult;

      reporter.onEnd(mockResult);

      // Verify all expected calls
      expect(consoleLogSpy).toHaveBeenCalledWith('Running 3 tests using 2 workers\n');
      expect(consoleLogSpy).toHaveBeenCalledWith('  ✓   test1');
      expect(consoleLogSpy).toHaveBeenCalledWith('  ✘   test2');
      expect(consoleLogSpy).toHaveBeenCalledWith('  ✓   test3');
      expect(consoleLogSpy).toHaveBeenCalledWith('\n2 passed, 1 failed');
      expect(consoleLogSpy).toHaveBeenCalledWith('✘ Some tests failed');
    });

    it('should handle large number of tests', () => {
      const mockConfig: FullConfig = {
        workers: 12,
      } as FullConfig;

      const mockSuite: Suite = {
        allTests: () => Array.from({ length: 100 }, (_, i) => ({ title: `test${i}` } as TestCase)),
      } as Suite;

      reporter.onBegin(mockConfig, mockSuite);

      // Simulate 95 passed, 5 failed
      for (let i = 0; i < 95; i++) {
        reporter.onTestEnd({ title: `test${i}` } as TestCase, { status: 'passed' } as TestResult);
      }
      for (let i = 95; i < 100; i++) {
        reporter.onTestEnd({ title: `test${i}` } as TestCase, { status: 'failed' } as TestResult);
      }

      const mockResult: FullResult = {
        status: 'failed',
        duration: 30000,
      } as FullResult;

      reporter.onEnd(mockResult);

      expect(consoleLogSpy).toHaveBeenCalledWith('Running 100 tests using 12 workers\n');
      expect(consoleLogSpy).toHaveBeenCalledWith('\n95 passed, 5 failed');
      expect(consoleLogSpy).toHaveBeenCalledWith('✘ Some tests failed');
    });
  });
});
