import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { ResultsIndexManager } from './ResultsIndex.js';
import { SnapshotIndexManager } from './SnapshotIndex.js';
import { type RuntimeConfig } from '../config.js';
import { formatStoryPath } from './ListSnapshots.js';

/**
 * Create a clickable hyperlink in terminal using OSC 8 escape sequence
 */
function createHyperlink(text: string, url: string): string {
  // OSC 8 escape sequence: \x1b]8;;<url>\x1b\\<text>\x1b]8;;\x1b\\
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Convert file path to file:// URL
 */
function filePathToUrl(filePath: string): string {
  // Convert to absolute path and then to file:// URL
  const absolutePath = path.resolve(filePath);
  // On Windows, we need to convert backslashes to forward slashes
  const normalizedPath = absolutePath.replace(/\\/g, '/');
  // Add file:// prefix
  return `file://${normalizedPath}`;
}

const STATUS_ICONS = {
  passed: '✓',
  failed: '✗',
  new: '🆕',
  missing: '⚠',
} as const;

const STATUS_COLORS = {
  passed: '\x1b[32m', // green
  failed: '\x1b[31m', // red
  new: '\x1b[36m', // cyan
  missing: '\x1b[33m', // yellow
} as const;

const RESET = '\x1b[0m';

function colorize(text: string, color: string): string {
  return `${color}${text}${RESET}`;
}

/**
 * Strip ANSI color codes from a string
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function listResults(
  config: RuntimeConfig,
  options?: {
    status?: 'passed' | 'failed' | 'new' | 'missing';
    include?: string[];
    exclude?: string[];
    grep?: string;
    outputPath?: string;
    outputFile?: string;
  },
): void {
  const resultsDir = config.resolvePath(config.resultsPath);

  // Collect output lines for file writing
  const outputLines: string[] = [];
  const writeLine = (line: string) => {
    outputLines.push(line);
    // Always print to console, but also collect for file if outputFile is specified
    console.log(line);
  };

  if (!fs.existsSync(resultsDir)) {
    const message = 'No results directory found.';
    writeLine(message);
    if (options?.outputFile) {
      writeOutputFile(options.outputFile, outputLines);
    }
    return;
  }

  const resultsIndexManager = new ResultsIndexManager(resultsDir);
  let entries = resultsIndexManager.getAllEntries();

  // Filter by include/exclude/grep patterns
  if (options?.include || options?.exclude || options?.grep) {
    entries = entries.filter((entry) => {
      // Normalize haystack: handle double dashes (--) which separate path from story name
      const hay = entry.storyId
        .toLowerCase()
        .replace(/--+/g, '-') // Replace double dashes with single dash
        .replace(/-+/g, '-'); // Collapse multiple hyphens

      // Check grep pattern (regex match on storyId)
      if (options.grep) {
        try {
          const re = new RegExp(options.grep);
          if (!re.test(entry.storyId)) return false;
        } catch {
          // Invalid regex -> ignore
        }
      }

      // Check include patterns (support * wildcard and normalize spaces/slashes)
      if (options.include && options.include.length > 0) {
        const matchesInclude = options.include.some((pattern) => {
          // Normalize pattern: convert spaces/slashes to hyphens, lowercase
          // Also handle double dashes (--) which separate path from story name
          const normalizedPattern = pattern
            .toLowerCase()
            .replace(/[/\s]+/g, '-') // Replace slashes and spaces with hyphens
            .replace(/--+/g, '-') // Replace double dashes with single dash
            .replace(/-+/g, '-') // Collapse multiple hyphens
            .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

          // If pattern contains *, treat as wildcard pattern
          if (normalizedPattern.includes('*')) {
            const regexPattern = normalizedPattern
              .split('*')
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('.*');
            try {
              const re = new RegExp(regexPattern, 'i');
              return re.test(entry.storyId);
            } catch {
              // Invalid regex -> fall back to substring match
              return hay.includes(normalizedPattern.replace(/\*/g, ''));
            }
          }
          // Otherwise, simple substring match
          return hay.includes(normalizedPattern);
        });
        if (!matchesInclude) return false;
      }

      // Check exclude patterns (support * wildcard and normalize spaces/slashes)
      if (options.exclude && options.exclude.length > 0) {
        const matchesExclude = options.exclude.some((pattern) => {
          // Normalize pattern: convert spaces/slashes to hyphens, lowercase
          // Also handle double dashes (--) which separate path from story name
          const normalizedPattern = pattern
            .toLowerCase()
            .replace(/[/\s]+/g, '-') // Replace slashes and spaces with hyphens
            .replace(/--+/g, '-') // Replace double dashes with single dash
            .replace(/-+/g, '-') // Collapse multiple hyphens
            .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

          // If pattern contains *, treat as wildcard pattern
          if (normalizedPattern.includes('*')) {
            const regexPattern = normalizedPattern
              .split('*')
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('.*');
            try {
              const re = new RegExp(regexPattern, 'i');
              return re.test(entry.storyId);
            } catch {
              // Invalid regex -> fall back to substring match
              return hay.includes(normalizedPattern.replace(/\*/g, ''));
            }
          }
          // Otherwise, simple substring match
          return hay.includes(normalizedPattern);
        });
        if (matchesExclude) return false;
      }

      return true;
    });
  }

  // Group all entries by status for summary
  const allByStatus = {
    passed: [] as typeof entries,
    failed: [] as typeof entries,
    new: [] as typeof entries,
    missing: [] as typeof entries,
  };

  for (const entry of entries) {
    allByStatus[entry.status].push(entry);
  }

  // Filter by status if specified
  const filteredEntries = options?.status
    ? entries.filter((e) => e.status === options.status)
    : entries;

  // Determine if we should show a concise format (only failed results, no summary)
  // If showing failed results and there are none, and no output file is specified,
  // don't show anything (--results with no failures should be silent)
  // However, if outputFile is specified, we should still write the file even if there are no results
  if (filteredEntries.length === 0 && options?.status === 'failed' && !options?.outputFile) {
    return;
  }

  const isConciseFormat = options?.status === 'failed' && filteredEntries.length > 0;

  if (!isConciseFormat) {
    writeLine(`\n${chalk.bold('Test Results:')}\n`);
    writeLine('═'.repeat(80));

    // Show summary of all results
    const totalAll = entries.length;
    const passedAll = allByStatus.passed.length;
    const failedAll = allByStatus.failed.length;
    const newSnapshotsAll = allByStatus.new.length;
    const missingAll = allByStatus.missing.length;

    // Format summary like status line: Passed: X • Failed: Y • New: Z • Missing: W • Total: N
    const breakdown: string[] = [];
    breakdown.push(chalk.green(`Passed: ${passedAll}`));
    breakdown.push(chalk.red(`Failed: ${failedAll}`));
    if (newSnapshotsAll > 0) {
      breakdown.push(colorize(`New: ${newSnapshotsAll}`, STATUS_COLORS.new));
    }
    if (missingAll > 0) {
      breakdown.push(colorize(`Missing: ${missingAll}`, STATUS_COLORS.missing));
    }
    breakdown.push(`Total: ${totalAll}`);
    writeLine(`\n${breakdown.join(chalk.dim(' • '))}`);
  } else {
    // Concise format: just the header with separator
    writeLine('\n' + chalk.bold('Test Results'));
  }

  if (filteredEntries.length === 0) {
    const statusText = options?.status ? `${options.status} ` : '';
    writeLine(`\nNo ${statusText}results to display.`.trim());
    if (options?.status === 'failed' && entries.length > 0) {
      writeLine(`\nUse --all to see all results, or --status passed to see passed tests.`);
    }
    writeLine('');
    if (options?.outputFile) {
      writeOutputFile(options.outputFile, outputLines);
    }
    return;
  }

  // Group filtered entries by status for details
  const byStatus = {
    passed: [] as typeof entries,
    failed: [] as typeof entries,
    new: [] as typeof entries,
    missing: [] as typeof entries,
  };

  for (const entry of filteredEntries) {
    byStatus[entry.status].push(entry);
  }

  // Show details grouped by story path
  const grouped = new Map<string, Array<(typeof entries)[0]>>();

  for (const entry of filteredEntries) {
    const pathKey = formatStoryPath(entry.storyId);
    if (!grouped.has(pathKey)) {
      grouped.set(pathKey, []);
    }
    grouped.get(pathKey)!.push(entry);
  }

  const sorted = Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  if (filteredEntries.length > 0 && !isConciseFormat) {
    const filteredTotal = filteredEntries.length;
    writeLine(
      `\nDetails (${filteredTotal} ${options?.status || 'filtered'} result${filteredTotal === 1 ? '' : 's'}):`,
    );
    writeLine('');
  }

  for (const [pathKey, items] of sorted) {
    // Format path key to be more readable
    const segments = pathKey.split('/').map((segment) =>
      segment
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' '),
    );
    const readablePath = segments.join(chalk.dim(' / '));

    writeLine(`\n${readablePath}`);
    writeLine('─'.repeat(Math.min(80, readablePath.length + 20)));

    for (const entry of items) {
      const icon = STATUS_ICONS[entry.status];
      const statusColor = STATUS_COLORS[entry.status];

      // Extract story name from path
      const storyParts = pathKey.split('/');
      const storyName = storyParts[storyParts.length - 1];
      const readableStoryName = storyName
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      // Build metadata string
      const metadata: string[] = [];
      if (entry.browser) metadata.push(entry.browser);
      if (entry.viewportName) metadata.push(entry.viewportName);

      let details = '';
      if (entry.status === 'failed') {
        const diff = entry.diffPixels !== undefined ? `${entry.diffPixels}px` : '';
        const percent =
          entry.diffPercent !== undefined ? ` (${entry.diffPercent.toFixed(2)}%)` : '';
        if (diff || percent) details = ` - ${diff}${percent}`;
      }
      if (entry.duration !== undefined) {
        // Format duration like the reporter: convert ms to seconds with dimmed unit
        const secs = entry.duration / 1000;
        const secsStr = secs.toFixed(1);
        const unit = chalk.dim('s');
        const durationStr = `${secsStr}${unit}`;
        details += details ? ` | ${durationStr}` : ` - ${durationStr}`;
      }

      const metadataStr = metadata.length > 0 ? ` (${metadata.join(', ')})` : '';
      // For passed status, show only the icon; for other statuses, show icon + status text
      const statusText =
        entry.status === 'passed'
          ? colorize(icon, statusColor)
          : colorize(`${icon} ${entry.status.toUpperCase()}`, statusColor);

      writeLine(`  ${statusText} ${readableStoryName}${metadataStr}${details}`);

      // Show clickable file paths for failed tests
      if (entry.status === 'failed') {
        const basePath = options?.outputPath
          ? path.resolve(path.dirname(options.outputPath))
          : process.cwd();
        const snapshotsDir = config.resolvePath(config.snapshotPath);
        const snapshotIndexManager = new SnapshotIndexManager(snapshotsDir);
        const snapshotPath = snapshotIndexManager.getSnapshotPath(
          entry.snapshotId,
          snapshotsDir,
          entry.storyId,
        );

        // Show snapshot (expected/baseline) path
        if (fs.existsSync(snapshotPath)) {
          const relativeSnapshot = path.relative(basePath, snapshotPath);
          if (options?.outputFile) {
            writeLine(`    Snapshot: ${relativeSnapshot}`);
          } else {
            const snapshotUrl = filePathToUrl(snapshotPath);
            const clickableSnapshot = createHyperlink(relativeSnapshot, snapshotUrl);
            writeLine(`    Snapshot: ${chalk.cyan(clickableSnapshot)}`);
          }
        }

        const actualPath = resultsIndexManager.getResultPath(
          entry.snapshotId,
          resultsDir,
          'actual',
        );
        const diffPath = resultsIndexManager.getResultPath(entry.snapshotId, resultsDir, 'diff');

        if (fs.existsSync(actualPath)) {
          const relativeActual = path.relative(basePath, actualPath);
          if (options?.outputFile) {
            writeLine(`    Actual: ${relativeActual}`);
          } else {
            const actualUrl = filePathToUrl(actualPath);
            const clickableActual = createHyperlink(relativeActual, actualUrl);
            writeLine(`    Actual: ${chalk.cyan(clickableActual)}`);
          }
        }

        if (fs.existsSync(diffPath)) {
          const relativeDiff = path.relative(basePath, diffPath);
          if (options?.outputFile) {
            writeLine(`    Diff: ${relativeDiff}`);
          } else {
            const diffUrl = filePathToUrl(diffPath);
            const clickableDiff = createHyperlink(relativeDiff, diffUrl);
            writeLine(`    Diff: ${chalk.cyan(clickableDiff)}`);
          }
        }
      } else if (entry.status === 'new') {
        // For new snapshots, show the snapshot path
        const basePath = options?.outputPath
          ? path.resolve(path.dirname(options.outputPath))
          : process.cwd();
        const snapshotsDir = config.resolvePath(config.snapshotPath);
        const snapshotIndexManager = new SnapshotIndexManager(snapshotsDir);
        const snapshotPath = snapshotIndexManager.getSnapshotPath(entry.snapshotId, snapshotsDir);

        if (fs.existsSync(snapshotPath)) {
          const relativeSnapshot = path.relative(basePath, snapshotPath);
          if (options?.outputFile) {
            writeLine(`    Snapshot: ${relativeSnapshot}`);
          } else {
            const snapshotUrl = filePathToUrl(snapshotPath);
            const clickableSnapshot = createHyperlink(relativeSnapshot, snapshotUrl);
            writeLine(`    Snapshot: ${chalk.cyan(clickableSnapshot)}`);
          }
        }
      }
    }
  }

  if (!isConciseFormat) {
    const filteredTotal = filteredEntries.length;
    writeLine(`\nTotal: ${filteredTotal} result(s) across ${sorted.length} story path(s)\n`);
  } else {
    // Add newline after last item in concise format
    writeLine('');
  }

  // Write to file if specified
  if (options?.outputFile) {
    writeOutputFile(options.outputFile, outputLines);
  }
}

/**
 * Write output lines to a file, stripping ANSI codes
 */
function writeOutputFile(filePath: string, lines: string[]): void {
  try {
  const content = lines.map((line) => stripAnsi(line)).join('\n');
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') {
      fs.mkdirSync(dir, { recursive: true });
    }
  fs.writeFileSync(filePath, content, 'utf8');
  } catch (error) {
    console.error(`Failed to write results file to ${filePath}: ${error}`);
    throw error;
  }
}
