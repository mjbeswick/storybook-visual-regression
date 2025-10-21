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

function extractStoryMetadata(data: StorybookIndex): {
  storyIds: string[];
  importPaths: Record<string, string>;
} {
  const entries = data.entries ?? {};
  const storyIds = Object.keys(entries).filter((id) => entries[id]?.type === 'story');
  const importPaths: Record<string, string> = {};

  for (const storyId of storyIds) {
    const entry = entries[storyId];
    if (entry && typeof entry.importPath === 'string') {
      importPaths[storyId] = entry.importPath;
    }
  }

  return { storyIds, importPaths };
}

async function cleanOrphanedSnapshots(
  indexData: StorybookIndex,
  runtimeOptions: ReturnType<typeof loadRuntimeOptions>,
): Promise<void> {
  if (!runtimeOptions.storybookMode) {
    console.log('');
  }
  console.log(chalk.bold('🗑️  Cleaning orphaned snapshots'));

  const entries = indexData.entries || {};
  const stories = Object.keys(entries)
    .map((id) => entries[id])
    .filter(
      (entry: any) =>
        entry &&
        entry.type === 'story' &&
        typeof entry.id === 'string' &&
        typeof entry.title === 'string' &&
        typeof entry.name === 'string',
    );

  // Create a set of all existing story snapshot paths
  const existingStoryPaths = new Set<string>();
  for (const story of stories) {
    if (!story.id) continue;
    const fullSnapshotPath = join(runtimeOptions.visualRegression.snapshotPath, `${story.id}.png`);
    existingStoryPaths.add(fullSnapshotPath);
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
  for (const snapshotFile of allSnapshotFiles) {
    if (!existingStoryPaths.has(snapshotFile)) {
      try {
        rmSync(snapshotFile, { force: true });
        deletedCount++;
        console.log(
          `  ${chalk.dim('•')} Deleted orphaned snapshot: ${relative(snapshotPath, snapshotFile)}`,
        );
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

async function globalSetup(_config: FullConfig): Promise<void> {
  const runtimeOptions = loadRuntimeOptions();
  const baseURL = runtimeOptions.storybookUrl;
  const projectCwd = runtimeOptions.originalCwd;

  if (!runtimeOptions.storybookMode) {
    console.log('');
  }
  console.log(chalk.bold('🔧 Storybook discovery')); // section header
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

  // Delete existing snapshots if --clean flag is set
  if (runtimeOptions.clean && runtimeOptions.updateSnapshots) {
    await cleanOrphanedSnapshots(indexData, runtimeOptions);
  }

  if (!runtimeOptions.storybookMode) {
    console.log('');
  }
}

export default globalSetup;
