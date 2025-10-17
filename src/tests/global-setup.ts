import chalk from 'chalk';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
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

async function cleanMatchingSnapshots(
  indexData: StorybookIndex,
  runtimeOptions: ReturnType<typeof loadRuntimeOptions>,
): Promise<void> {
  console.log('');
  console.log(chalk.bold('🗑️  Cleaning existing snapshots'));

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

  // Apply filtering (same logic as in storybook.spec.ts)
  let filteredStories = [...stories];

  const includePatterns = runtimeOptions.include;
  const excludePatterns = runtimeOptions.exclude;
  const grepPattern = runtimeOptions.grep;

  // Apply include patterns
  if (includePatterns.length > 0) {
    filteredStories = filteredStories.filter((story: any) => {
      const displayName = `${story.title} › ${story.name}`;
      return includePatterns.some((pattern) => {
        const lowerPattern = pattern.toLowerCase();
        const lowerStoryId = story.id.toLowerCase();
        const lowerDisplayName = displayName.toLowerCase();

        const hasGlobChars = /[*?[\]{}]/.test(pattern);
        if (hasGlobChars) {
          try {
            const regexPattern = lowerPattern
              .replace(/\*/g, '.*')
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\\\.\*/g, '.*');
            const regex = new RegExp(regexPattern, 'i');
            return regex.test(lowerStoryId) || regex.test(lowerDisplayName);
          } catch {
            return lowerStoryId.includes(lowerPattern) || lowerDisplayName.includes(lowerPattern);
          }
        } else {
          return lowerStoryId.includes(lowerPattern) || lowerDisplayName.includes(lowerPattern);
        }
      });
    });
  }

  // Apply exclude patterns
  if (excludePatterns.length > 0) {
    filteredStories = filteredStories.filter((story: any) => {
      const displayName = `${story.title} › ${story.name}`;
      return !excludePatterns.some((pattern) => {
        const lowerPattern = pattern.toLowerCase();
        const lowerStoryId = story.id.toLowerCase();
        const lowerDisplayName = displayName.toLowerCase();

        try {
          const regexPattern = lowerPattern
            .replace(/\*/g, '.*')
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\\\.\*/g, '.*');
          const regex = new RegExp(regexPattern, 'i');
          return regex.test(lowerStoryId) || regex.test(lowerDisplayName);
        } catch {
          return lowerStoryId.includes(lowerPattern) || lowerDisplayName.includes(lowerPattern);
        }
      });
    });
  }

  // Apply grep pattern
  if (grepPattern) {
    try {
      const regex = new RegExp(grepPattern, 'i');
      filteredStories = filteredStories.filter((story: any) => regex.test(story.id));
    } catch {
      console.log(`  ${chalk.yellow('⚠')} Invalid regex pattern: ${grepPattern}`);
    }
  }

  if (filteredStories.length === 0) {
    console.log(`  ${chalk.dim('•')} No stories match the filters - nothing to clean`);
    return;
  }

  // Delete snapshots for filtered stories
  let deletedCount = 0;
  let skippedCount = 0;
  const snapshotPath = runtimeOptions.visualRegression.snapshotPath;

  for (const story of filteredStories) {
    // Build snapshot path (same logic as in storybook.spec.ts)
    if (!story.title || !story.name) continue;
    const folderPath = story.title.split(' / ').join('/');
    const fileName = story.name.replace(/[<>:"|?*]/g, '-');
    const fullSnapshotPath = join(snapshotPath, folderPath, `${fileName}.png`);

    if (existsSync(fullSnapshotPath)) {
      try {
        rmSync(fullSnapshotPath, { force: true });
        deletedCount++;
      } catch (deleteError) {
        console.log(
          `  ${chalk.yellow('⚠')} Failed to delete ${fullSnapshotPath}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
        );
      }
    } else {
      skippedCount++;
    }
  }

  // Clean up empty directories
  const uniqueFolders = new Set<string>();
  for (const story of filteredStories) {
    if (!story.title) continue;
    const folderPath = story.title.split(' / ').join('/');
    const parts = folderPath.split('/');
    // Build all parent paths
    for (let i = parts.length; i > 0; i--) {
      uniqueFolders.add(join(snapshotPath, ...parts.slice(0, i)));
    }
  }

  // Try to remove empty directories (from deepest to shallowest)
  const sortedFolders = Array.from(uniqueFolders).sort((a, b) => b.length - a.length);
  for (const folder of sortedFolders) {
    try {
      if (existsSync(folder)) {
        rmSync(folder, { recursive: false }); // Only remove if empty
      }
    } catch {
      // Ignore errors - directory might not be empty
    }
  }

  console.log(
    `  ${chalk.green('✓')} Cleaned ${chalk.bold(deletedCount)} snapshot${deletedCount !== 1 ? 's' : ''}${skippedCount > 0 ? chalk.dim(` (${skippedCount} didn't exist)`) : ''}`,
  );
}

async function globalSetup(_config: FullConfig): Promise<void> {
  const runtimeOptions = loadRuntimeOptions();
  const baseURL = runtimeOptions.storybookUrl;
  const projectCwd = runtimeOptions.originalCwd;

  console.log('');
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

  const { storyIds, importPaths } = extractStoryMetadata(indexData);

  if (storyIds.length === 0) {
    throw new Error('Storybook index.json did not contain any runnable stories.');
  }

  const sourceLabel = source === 'server' ? 'dev server' : 'static export';
  console.log(
    `  ${chalk.green('✓')} Found ${chalk.bold(storyIds.length)} stories via ${sourceLabel}`,
  );

  // Delete existing snapshots if --clean flag is set
  if (runtimeOptions.clean && runtimeOptions.updateSnapshots) {
    await cleanMatchingSnapshots(indexData, runtimeOptions);
  }

  console.log('');
}

export default globalSetup;
