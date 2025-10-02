import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { FullConfig } from '@playwright/test';

type StorybookIndex = {
  entries?: Record<
    string,
    {
      type?: string;
      importPath?: string;
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

function loadStorybookFromStatic(): StorybookIndex {
  const projectCwd = process.env.ORIGINAL_CWD || process.cwd();
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

function extractStoryMetadata(data: StorybookIndex) {
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

async function globalSetup(config: FullConfig) {
  const baseURL = process.env.STORYBOOK_URL || 'http://localhost:9009';

  console.log('');
  console.log(chalk.bold('🔧 Storybook discovery')); // section header
  console.log(`  ${chalk.dim('•')} Target URL: ${chalk.cyan(baseURL)}`);

  let indexData: StorybookIndex | null = null;
  let source: 'server' | 'static' | null = null;

  try {
    console.log(`  ${chalk.dim('•')} Checking running Storybook dev server...`);
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
      indexData = loadStorybookFromStatic();
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

  process.env.STORYBOOK_STORY_IDS = JSON.stringify(storyIds);
  process.env.STORYBOOK_IMPORT_PATHS = JSON.stringify(importPaths);
  process.env.STORYBOOK_TOTAL_STORIES = String(storyIds.length);

  const sourceLabel = source === 'server' ? 'dev server' : 'static export';
  console.log(`  ${chalk.green('✓')} Found ${chalk.bold(storyIds.length)} stories via ${sourceLabel}`);
  console.log('');
}

export default globalSetup;
