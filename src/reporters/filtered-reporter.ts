import {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import chalk from 'chalk';
import { existsSync, rmSync, statSync, readdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';

class FilteredReporter implements Reporter {
  private failures: TestCase[] = [];
  private passed = 0;
  private failed = 0;
  private resultsRoot: string | null = null;

  private getResultsRoot(config: FullConfig): string {
    if (this.resultsRoot) return this.resultsRoot;
    const base = process.env.PLAYWRIGHT_OUTPUT_DIR
      ? `${process.env.PLAYWRIGHT_OUTPUT_DIR}/results`
      : 'visual-regression/results';
    this.resultsRoot = base;
    return base;
  }

  private safeRemoveEmptyDirsUp(startDir: string, stopDir: string): void {
    let cursor = startDir;
    // Only prune within the results root to avoid accidental removals
    while (cursor.startsWith(stopDir)) {
      try {
        const entries = readdirSync(cursor);
        if (entries.length > 0) break;
        rmSync(cursor, { recursive: true, force: true });
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      } catch {
        break;
      }
    }
  }

  private removePathIfExists(filePath: string): void {
    try {
      if (!existsSync(filePath)) return;
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        rmSync(filePath, { recursive: true, force: true });
      } else {
        unlinkSync(filePath);
      }
    } catch {
      // ignore cleanup errors
    }
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.getResultsRoot(config);
    // No header output; only print story names during tests
  }

  onStdOut(_chunk: string | Buffer, _test?: TestCase, _result?: TestResult): void {
    // Suppress stdout
  }

  onStdErr(_chunk: string | Buffer, _test?: TestCase, _result?: TestResult): void {
    // Suppress stderr
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const displayTitle = test.title.replace(/^snapshots-/, '');
    const baseUrl = (process.env.STORYBOOK_URL || 'http://localhost:9009').replace(/\/$/, '');
    const idMatch = displayTitle.match(/\[(.*)\]$/);
    const storyIdForUrl = idMatch ? idMatch[1] : displayTitle;
    const outputCore =
      process.env.SVR_PRINT_URLS === 'true'
        ? `${baseUrl}/iframe.html?id=${storyIdForUrl}&viewMode=story`
        : displayTitle;

    if (result.status === 'failed') {
      this.failures.push(test);
      this.failed++;
      const durationMs = result.duration || 0;
      const seconds = durationMs / 1000;
      console.log(
        `${chalk.red('✗')} ${outputCore} ${chalk.gray(`(${seconds.toFixed(seconds < 10 ? 1 : 0)}s)`)}`,
      );
      // Keep diffs, remove non-diff attachments for failures
      for (const attachment of result.attachments || []) {
        if (!attachment.path) continue;
        const name = (attachment.name || '').toLowerCase();
        if (name.includes('diff')) continue;
        this.removePathIfExists(attachment.path);
      }
    } else if (result.status === 'passed') {
      this.passed++;
      const durationMs = result.duration || 0;
      const seconds = durationMs / 1000;
      console.log(
        `${chalk.green('✓')} ${outputCore} ${chalk.gray(`(${seconds.toFixed(seconds < 10 ? 1 : 0)}s)`)}`,
      );
      // Remove all artifacts for passed tests and prune empty folders up to results root
      for (const attachment of result.attachments || []) {
        if (!attachment.path) continue;
        const attachmentDir = dirname(attachment.path);
        this.removePathIfExists(attachment.path);
        const root = this.resultsRoot || '';
        this.safeRemoveEmptyDirsUp(attachmentDir, root);
      }
    }
  }

  onEnd(_result: FullResult): void {
    // No summary output; keep output to story names only
  }
}

export default FilteredReporter;
