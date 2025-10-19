import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { writeFileSync } from 'fs';
import { join } from 'path';

export type JsonTestResult = {
  storyId: string;
  title: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
  duration: number;
  error?: string;
  attachments?: {
    name: string;
    path?: string;
    contentType: string;
  }[];
  diffImagePath?: string;
  expectedImagePath?: string;
  actualImagePath?: string;
};

export type JsonOutput = {
  status: 'passed' | 'failed' | 'timedout' | 'interrupted';
  startTime: number;
  duration: number;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  tests: JsonTestResult[];
};

export default class JsonReporter implements Reporter {
  private startTime = 0;
  private tests: JsonTestResult[] = [];

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.startTime = Date.now();
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

    const testResult: JsonTestResult = {
      storyId,
      title,
      name,
      status: result.status,
      duration: result.duration,
      error: result.error?.message,
      attachments: result.attachments.map((a) => ({
        name: a.name,
        path: a.path,
        contentType: a.contentType,
      })),
      diffImagePath,
      expectedImagePath,
      actualImagePath,
    };

    this.tests.push(testResult);

    // Output individual test result immediately for real-time updates
    console.log(
      JSON.stringify({
        type: 'test-result',
        test: testResult,
      }),
    );
  }

  onEnd(result: FullResult): void {
    const duration = Date.now() - this.startTime;

    const passed = this.tests.filter((t) => t.status === 'passed').length;
    const failed = this.tests.filter((t) => t.status === 'failed').length;
    const skipped = this.tests.filter((t) => t.status === 'skipped').length;

    const output: JsonOutput = {
      status: result.status,
      startTime: this.startTime,
      duration,
      totalTests: this.tests.length,
      passed,
      failed,
      skipped,
      tests: this.tests,
    };

    // Output to stdout for CLI consumption
    console.log(JSON.stringify(output, null, 2));

    // Also write to file for later reference
    try {
      const outputPath = join(process.cwd(), 'visual-regression', 'results', 'test-results.json');
      writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    } catch (error) {
      // Silent fail - stdout output is primary
    }
  }
}
