import chalk from 'chalk';
import { existsSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import type { FullConfig } from '@playwright/test';
import { loadRuntimeOptions } from '../runtime/runtime-options.js';

type StorybookIndex = {
  entries?: Record<
    string,
    {
      type?: string;
      importPath?: string;
      title?: string;
      name?: string;
      id?: string;
    }
  >;
};

const STORYBOOK_INDEX_TIMEOUT = 10_000;

async function loadStorybookFromServer(baseURL: string): Promise<StorybookIndex> {
  const mainResponse = await fetch(baseURL, {
    signal: AbortSignal.timeout(STORYBOOK_INDEX_TIMEOUT),
  });

  if (!mainResponse.ok) {
    throw new Error(`main page returned ${mainResponse.status}`);
  }

  const indexResponse = await fetch(`${baseURL}/index.json`, {
    signal: AbortSignal.timeout(STORYBOOK_INDEX_TIMEOUT),
  });

  if (!indexResponse.ok) {
    throw new Error(`index.json returned ${indexResponse.status}`);
  }

  const contentType = indexResponse.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    throw new Error('index.json does not have correct content-type');
  }

  const data = (await indexResponse.json()) as StorybookIndex;
  if (!data.entries) {
    throw new Error('index.json does not contain entries');
  }

  return data;
}

function loadStorybookFromStatic(projectCwd: string): StorybookIndex {
  const staticIndexPath = join(projectCwd, 'storybook-static', 'index.json');

  if (!existsSync(staticIndexPath)) {
    throw new Error('storybook-static/index.json not found');
  }

  const raw = readFileSync(staticIndexPath, 'utf8');
  const data = JSON.parse(raw) as StorybookIndex;
  if (!data.entries) {
    throw new Error('index.json does not contain entries');
  }

  return data;
}

/**
 * Sanitize a filename/directory name by removing invalid characters
 */
function sanitizePathSegment(segment: string): string {
  // Replace invalid filename characters with dashes
  // Windows: < > : " | ? * \
  // Unix: / (forward slash)
  // Also replace spaces with dashes for better filesystem compatibility
  // Remove leading/trailing spaces, dots, and dashes
  // Remove control characters
  return segment
    .replace(/[<>:"|?*\\/]/g, '-') // Replace invalid path characters
    .replace(/\s+/g, '-') // Replace spaces (and multiple spaces) with single dash
    .replace(/\.\./g, '-') // Remove .. sequences
    .replace(/^[\s.-]+|[\s.-]+$/g, '') // Remove leading/trailing spaces, dots, dashes
    .replace(/-+/g, '-') // Replace multiple dashes with single dash
    .trim();
}

function extractStoryMetadata(data: StorybookIndex): {
  storyIds: string[];
  importPaths: Record<string, string>;
  storySnapshotPaths: Record<string, string>;
} {
  const entries = data.entries ?? {};
  const storyIds = Object.keys(entries).filter((id) => entries[id]?.type === 'story');
  const importPaths: Record<string, string> = {};
  const storySnapshotPaths: Record<string, string> = {};

  for (const storyId of storyIds) {
    const entry = entries[storyId];
    if (entry && typeof entry.importPath === 'string') {
      importPaths[storyId] = entry.importPath;
    }

    // Generate snapshot path matching directory structure from story title/name
    const human =
      entry && (entry.title || entry.name)
        ? `${entry.title ?? ''}${entry.title && entry.name ? ' / ' : ''}${entry.name ?? ''}`
        : storyId;

    const displayName = human || storyId;
    const parts = displayName
      .split(' / ')
      .map((part) => sanitizePathSegment(part))
      .filter(Boolean);

    if (parts.length > 0) {
      const fileName = parts[parts.length - 1] || storyId;
      const dirParts = parts.length > 1 ? parts.slice(0, -1) : [];
      const pathParts =
        dirParts.length > 0 ? [...dirParts, `${fileName}.png`] : [`${fileName}.png`];
      storySnapshotPaths[storyId] = join(...pathParts);
    } else {
      storySnapshotPaths[storyId] = `${storyId}.png`;
    }
  }

  return { storyIds, importPaths, storySnapshotPaths };
}

async function cleanOrphanedSnapshots(
  indexData: StorybookIndex,
  runtimeOptions: ReturnType<typeof loadRuntimeOptions>,
): Promise<void> {
  console.log('');
  console.log(chalk.bold('🗑️  Cleaning orphaned snapshots'));

  // Use the same path generation logic as the test file
  const { storySnapshotPaths } = extractStoryMetadata(indexData);

  // Create a set of all existing story snapshot paths (relative paths)
  const existingSnapshotPaths = new Set<string>();
  for (const [storyId, relativePath] of Object.entries(storySnapshotPaths)) {
    existingSnapshotPaths.add(relativePath);
  }

  // Find all snapshot files in the snapshot directory
  const snapshotPath = runtimeOptions.visualRegression.snapshotPath;
  if (!existsSync(snapshotPath)) {
    console.log(`  ${chalk.dim('•')} No snapshot directory found - nothing to clean`);
    return;
  }

  let deletedCount = 0;
  let skippedCount = 0;

  // Recursively find all PNG files in the snapshot directory
  function findSnapshotFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findSnapshotFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.png')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Ignore errors reading directories
    }
    return files;
  }

  const allSnapshotFiles = findSnapshotFiles(snapshotPath);

  // Delete snapshots that don't match any existing story
  // Compare relative paths from snapshot directory root
  for (const snapshotFile of allSnapshotFiles) {
    const relativePath = relative(snapshotPath, snapshotFile);

    // Normalize path separators for comparison (handle both / and \)
    const normalizedRelativePath = relativePath.replace(/\\/g, '/');

    if (!existingSnapshotPaths.has(normalizedRelativePath)) {
      try {
        rmSync(snapshotFile, { force: true });
        deletedCount++;
        console.log(`  ${chalk.dim('•')} Deleted orphaned snapshot: ${relativePath}`);
      } catch (deleteError) {
        console.log(
          `  ${chalk.yellow('⚠')} Failed to delete ${snapshotFile}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
        );
      }
    } else {
      skippedCount++;
    }
  }

  // Clean up empty directories (simplified since we only have flat structure)
  function removeEmptyDirectories(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (entries.length === 0) {
        rmSync(dir, { recursive: true, force: true });
        console.log(`  ${chalk.dim('•')} Removed empty directory: ${relative(snapshotPath, dir)}`);
        // Try to remove parent directory too
        const parentDir = dirname(dir);
        if (parentDir !== snapshotPath) {
          removeEmptyDirectories(parentDir);
        }
      }
    } catch (error) {
      // Ignore errors
    }
  }

  // Remove empty directories (from deepest to shallowest)
  const allDirs = new Set<string>();
  function collectDirectories(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = join(dir, entry.name);
          allDirs.add(fullPath);
          collectDirectories(fullPath);
        }
      }
    } catch (error) {
      // Ignore errors
    }
  }

  collectDirectories(snapshotPath);
  const sortedDirs = Array.from(allDirs).sort((a, b) => b.length - a.length);
  for (const dir of sortedDirs) {
    removeEmptyDirectories(dir);
  }

  console.log(`  ✓ Cleaned ${deletedCount} orphaned snapshots (${skippedCount} kept)`);
}

async function cleanOrphanedResults(
  indexData: StorybookIndex,
  runtimeOptions: ReturnType<typeof loadRuntimeOptions>,
): Promise<void> {
  console.log('');
  console.log(chalk.bold('🧹 Cleaning orphaned results'));

  // Use the same path generation logic as the test file
  const { storySnapshotPaths } = extractStoryMetadata(indexData);

  // Create a set of all valid result file paths (relative paths)
  // Results can be: snapshot.png, snapshot-diff.png, snapshot-error.png
  const validResultPaths = new Set<string>();
  for (const relativePath of Object.values(storySnapshotPaths)) {
    validResultPaths.add(relativePath);
    validResultPaths.add(relativePath.replace(/\.png$/i, '-diff.png'));
    validResultPaths.add(relativePath.replace(/\.png$/i, '-error.png'));
  }

  const resultsRoot = runtimeOptions.visualRegression.resultsPath;
  if (!existsSync(resultsRoot)) {
    console.log(`  ${chalk.dim('•')} No results directory found - nothing to clean`);
    return;
  }

  let deletedFiles = 0;

  const walk = (dir: string): void => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          // Remove empty directory
          try {
            const after = readdirSync(full);
            if (after.length === 0) {
              rmSync(full, { recursive: true, force: true });
              console.log(`  ${chalk.dim('•')} Removed empty directory: ${full}`);
            }
          } catch {
            /* ignore */
          }
        } else if (entry.isFile() && entry.name.endsWith('.png')) {
          // Compare relative paths from results directory root
          const relativePath = relative(resultsRoot, full);
          const normalizedRelativePath = relativePath.replace(/\\/g, '/');

          // Check if this file matches any valid result path
          const isOrphan = !validResultPaths.has(normalizedRelativePath);

          if (isOrphan) {
            try {
              rmSync(full, { force: true });
              deletedFiles++;
              console.log(`  ${chalk.dim('•')} Deleted orphaned result: ${relativePath}`);
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  };

  walk(resultsRoot);
  console.log(`  ✓ Cleaned ${deletedFiles} orphaned result files`);
}

async function globalSetup(_config: FullConfig): Promise<void> {
  const runtimeOptions = loadRuntimeOptions();
  const baseURL = runtimeOptions.storybookUrl;
  const projectCwd = runtimeOptions.originalCwd;

  console.log('');
  console.log(chalk.bold('🕵️‍♂️ Storybook discovery')); // section header
  console.log(`  ${chalk.dim('•')} Target URL: ${chalk.cyan(baseURL)}`);

  let indexData: StorybookIndex | null = null;
  let source: 'server' | 'static' | null = null;

  try {
    console.log(`  ${chalk.dim('•')} Checking running Storybook dev server...`);
    // Playwright webServer should have ensured readiness; do a single fetch to load index
    indexData = await loadStorybookFromServer(baseURL);
    source = 'server';
    console.log(`  ${chalk.green('✓')} Dev server is ready`);
  } catch (error) {
    console.log(
      `  ${chalk.yellow('•')} Dev server unavailable: ${chalk.dim(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }

  if (!indexData) {
    console.log(`  ${chalk.dim('•')} Checking static Storybook export...`);
    try {
      indexData = loadStorybookFromStatic(projectCwd);
      source = 'static';
      console.log(`  ${chalk.green('✓')} Loaded storybook-static/index.json`);
    } catch (error) {
      console.log(
        `  ${chalk.red('✗')} Unable to load static export: ${chalk.dim(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    }
  }

  if (!indexData || !source) {
    throw new Error(
      'Unable to load Storybook index.json. Ensure the Storybook server is running or build storybook-static.',
    );
  }

  const { storyIds } = extractStoryMetadata(indexData);
  if (storyIds.length === 0) {
    throw new Error('Storybook index.json did not contain any runnable stories.');
  }

  const sourceLabel = source === 'server' ? 'dev server' : 'static export';
  console.log(
    `  ${chalk.green('✓')} Found ${chalk.bold(storyIds.length)} stories via ${sourceLabel}`,
  );

  // Automatically clean orphaned snapshots when running in update mode
  if (runtimeOptions.updateSnapshots && runtimeOptions.clean) {
    await cleanOrphanedSnapshots(indexData, runtimeOptions);
  }

  // Always prune results that do not correspond to any current story id
  await cleanOrphanedResults(indexData, runtimeOptions);
}

export default globalSetup;
