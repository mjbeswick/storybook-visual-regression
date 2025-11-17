import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { SnapshotIndexManager } from './SnapshotIndex.js';
import { type RuntimeConfig } from '../config.js';

export function formatStoryPath(storyId: string): string {
  const [pathPart, ...storyParts] = storyId.split('--');
  const storyName = storyParts.join('--') || 'default';
  const pathSegments = pathPart.split('-').filter(Boolean);
  
  return pathSegments.length > 0
    ? `${pathSegments.join('/')}/${storyName}`
    : storyName;
}

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

export function listSnapshots(config: RuntimeConfig): void {
  const snapshotsDir = config.resolvePath(config.snapshotPath);
  
  if (!fs.existsSync(snapshotsDir)) {
    console.log('No snapshots directory found.');
    return;
  }

  const indexManager = new SnapshotIndexManager(snapshotsDir);
  const entries = indexManager.getAllEntries();

  if (entries.length === 0) {
    console.log('No snapshots found.');
    return;
  }

  // Group by story path
  const grouped = new Map<string, Array<{
    entry: any;
    snapshotPath: string;
  }>>();

  for (const entry of entries) {
    const snapshotPath = indexManager.getSnapshotPath(entry.snapshotId, snapshotsDir, entry.storyId);
    if (!fs.existsSync(snapshotPath)) {
      continue;
    }

    const pathKey = formatStoryPath(entry.storyId);
    if (!grouped.has(pathKey)) {
      grouped.set(pathKey, []);
    }
    grouped.get(pathKey)!.push({ entry, snapshotPath });
  }

  // Sort by path
  const sorted = Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\n${chalk.cyan('📸')} ${chalk.bold('Snapshots')} ${chalk.dim(`(${entries.length} total)`)}\n`);

  for (const [pathKey, items] of sorted) {
    // Format path key to be more readable
    const segments = pathKey.split('/').map(segment => 
      segment.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    );
    const readablePath = segments.join(chalk.dim(' / '));
    
    console.log(`\n${chalk.bold(readablePath)}`);
    console.log(chalk.dim('─'.repeat(Math.min(80, readablePath.length + 20))));
    
    // Sort items by viewport name, then browser
    const sortedItems = items.sort((a, b) => {
      const viewportCompare = (a.entry.viewportName || '').localeCompare(b.entry.viewportName || '');
      if (viewportCompare !== 0) return viewportCompare;
      return (a.entry.browser || '').localeCompare(b.entry.browser || '');
    });
    
    // Extract story name from path (last segment)
    const storyParts = pathKey.split('/');
    const storyName = storyParts[storyParts.length - 1];
    const readableStoryName = storyName
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    
    for (const item of sortedItems) {
      const { entry, snapshotPath } = item;
      
      // Build viewport name string (e.g., "unattended", "attended")
      // Always include viewport name if it exists in the entry
      const viewportName = entry.viewportName && entry.viewportName.trim()
        ? entry.viewportName.split('-').map((word: string) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
        : null;
      
      // Get relative path from snapshots directory
      const relativePath = path.relative(snapshotsDir, snapshotPath);
      
      // Create clickable file path
      const fileUrl = filePathToUrl(snapshotPath);
      const clickablePath = createHyperlink(relativePath, fileUrl);
      
      // Format: story name on bullet line, (browser viewport) path on next line
      const browser = entry.browser || 'chromium';
      const bullet = chalk.dim('•');
      const displayLine = `  ${bullet} ${readableStoryName}`;
      
      console.log(displayLine);
      
      // Build browser and viewport info in parentheses
      // Always include viewport name if it exists in the entry
      const browserViewportInfo = viewportName
        ? `(${browser} ${viewportName})`
        : `(${browser})`;
      const pathColored = chalk.cyan(clickablePath);
      console.log(`    ${browserViewportInfo} ${pathColored}`);
    }
  }

  console.log(`\n\n${chalk.dim(`Total: ${entries.length} snapshot(s) across ${sorted.length} story path(s)`)}\n`);
}

