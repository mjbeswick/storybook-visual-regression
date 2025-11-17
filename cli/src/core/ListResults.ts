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

export function listResults(
  config: RuntimeConfig,
  options?: {
    status?: 'passed' | 'failed' | 'new' | 'missing';
    include?: string[];
    exclude?: string[];
    grep?: string;
    outputPath?: string;
  },
): void {
  const resultsDir = config.resolvePath(config.resultsPath);

  if (!fs.existsSync(resultsDir)) {
    console.log('No results directory found.');
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

  console.log(`\n📊 Test Results\n`);
  console.log('═'.repeat(80));

  // Show summary of all results
  const totalAll = entries.length;
  const passedAll = allByStatus.passed.length;
  const failedAll = allByStatus.failed.length;
  const newSnapshotsAll = allByStatus.new.length;
  const missingAll = allByStatus.missing.length;

  console.log(`\nSummary:`);
  console.log(`  ${colorize(`✓ Passed: ${passedAll}`, STATUS_COLORS.passed)}`);
  console.log(`  ${colorize(`✗ Failed: ${failedAll}`, STATUS_COLORS.failed)}`);
  console.log(`  ${colorize(`🆕 New: ${newSnapshotsAll}`, STATUS_COLORS.new)}`);
  console.log(`  ${colorize(`⚠ Missing: ${missingAll}`, STATUS_COLORS.missing)}`);
  console.log(`  Total: ${totalAll}`);

  if (filteredEntries.length === 0) {
    const statusText = options?.status ? `${options.status} ` : '';
    console.log(`\nNo ${statusText}results to display.`.trim());
    if (options?.status === 'failed' && totalAll > 0) {
      console.log(`\nUse --all to see all results, or --status passed to see passed tests.`);
    }
    console.log('');
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

  if (filteredEntries.length > 0) {
    const filteredTotal = filteredEntries.length;
    console.log(
      `\nDetails (${filteredTotal} ${options?.status || 'filtered'} result${filteredTotal === 1 ? '' : 's'}):`,
    );
    console.log('');
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

    console.log(`\n${readablePath}`);
    console.log('─'.repeat(Math.min(80, readablePath.length + 20)));

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

      console.log(`  ${statusText} ${readableStoryName}${metadataStr}${details}`);

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
          const snapshotUrl = filePathToUrl(snapshotPath);
          const clickableSnapshot = createHyperlink(relativeSnapshot, snapshotUrl);
          console.log(`    Snapshot: ${chalk.cyan(clickableSnapshot)}`);
        }

        const actualPath = resultsIndexManager.getResultPath(
          entry.snapshotId,
          resultsDir,
          'actual',
        );
        const diffPath = resultsIndexManager.getResultPath(entry.snapshotId, resultsDir, 'diff');

        if (fs.existsSync(actualPath)) {
          const relativeActual = path.relative(basePath, actualPath);
          const actualUrl = filePathToUrl(actualPath);
          const clickableActual = createHyperlink(relativeActual, actualUrl);
          console.log(`    Actual: ${chalk.cyan(clickableActual)}`);
        }

        if (fs.existsSync(diffPath)) {
          const relativeDiff = path.relative(basePath, diffPath);
          const diffUrl = filePathToUrl(diffPath);
          const clickableDiff = createHyperlink(relativeDiff, diffUrl);
          console.log(`    Diff: ${chalk.cyan(clickableDiff)}`);
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
          const snapshotUrl = filePathToUrl(snapshotPath);
          const clickableSnapshot = createHyperlink(relativeSnapshot, snapshotUrl);
          console.log(`    Snapshot: ${chalk.cyan(clickableSnapshot)}`);
        }
      }
    }
  }

  console.log('\n' + '═'.repeat(80));
  const filteredTotal = filteredEntries.length;
  console.log(`\nTotal: ${filteredTotal} result(s) across ${sorted.length} story path(s)\n`);
}
