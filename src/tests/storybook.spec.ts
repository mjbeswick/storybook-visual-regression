import { readFileSync } from 'fs';
import { join } from 'path';

import { expect, test } from '@playwright/test';

// Default viewport configurations - will be overridden by discovered configurations
const defaultViewportSizes: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1024, height: 768 },
};
const defaultViewportKey = 'desktop';

// Get Storybook URL from environment or use default
const storybookUrl = process.env.STORYBOOK_URL || 'http://localhost:9009';

// Function to get story IDs from Storybook
async function getStoryIds(): Promise<string[]> {
  try {
    // Try to get stories from dev server first
    const response = await fetch(`${storybookUrl}/index.json`);
    if (response.ok) {
      const indexData = await response.json();
      const entries = indexData.entries || {};
      return Object.keys(entries).filter((id) => entries[id].type === 'story');
    } else {
      throw new Error('Dev server not available');
    }
  } catch (error) {
    // Fallback to built files
    try {
      const indexFile = join(process.cwd(), 'storybook-static/index.json');
      const indexData = JSON.parse(readFileSync(indexFile, 'utf8'));
      const entries = indexData.entries || {};
      return Object.keys(entries).filter((id) => entries[id].type === 'story');
    } catch {
      console.error('Error reading Storybook data:', error);
      console.log('Make sure Storybook dev server is running or run "npm run build-storybook" first');
      throw new Error('Unable to discover stories from Storybook');
    }
  }
}

// Function to get story import paths
async function getStoryImportPaths(): Promise<Record<string, string>> {
  const storyImportPaths: Record<string, string> = {};
  try {
    const response = await fetch(`${storybookUrl}/index.json`);
    if (response.ok) {
      const indexData = await response.json();
      const entries = indexData.entries || {};
      for (const id of Object.keys(entries)) {
        const entry = entries[id];
        if (entry && typeof entry.importPath === 'string') {
          storyImportPaths[id] = entry.importPath;
        }
      }
    }
  } catch (error) {
    // Fallback to built files
    try {
      const indexFile = join(process.cwd(), 'storybook-static/index.json');
      const indexData = JSON.parse(readFileSync(indexFile, 'utf8'));
      const entries = indexData.entries || {};
      for (const id of Object.keys(entries)) {
        const entry = entries[id];
        if (entry && typeof entry.importPath === 'string') {
          storyImportPaths[id] = entry.importPath;
        }
      }
    } catch {
      // ignore read/parse errors
    }
  }
  return storyImportPaths;
}

// Single test that runs all stories
test('Storybook Visual Regression Tests', async ({ page }) => {
  const storyIds = await getStoryIds();
  const storyImportPaths = await getStoryImportPaths();
  
  console.log(`Found ${storyIds.length} stories to test`);

  for (const storyId of storyIds) {
    console.log(`Testing story: ${storyId}`);
    
    // Determine viewport key from story source (if specified), else use default
    let viewportKey = defaultViewportKey;
    const importPath = storyImportPaths[storyId];
    if (importPath) {
      try {
        const storySource = readFileSync(
          join(process.cwd(), importPath.replace(/^\.\//, '')),
          'utf8',
        );
        const match = storySource.match(
          /globals\s*:\s*\{[^}]*viewport\s*:\s*\{[^}]*value\s*:\s*['"](\w+)['"][^}]*\}[^}]*\}/,
        );
        if (match && match[1] && defaultViewportSizes[match[1]]) {
          viewportKey = match[1];
        }
      } catch {
        // ignore read/parse errors and keep default
      }
    }

    const size = defaultViewportSizes[viewportKey] || defaultViewportSizes[defaultViewportKey];
    await page.setViewportSize(size);

    // Freeze time to ensure consistent timestamps and stable timer-based updates
    await page.clock.install({
      time: new Date('2024-01-15T10:30:00.000Z'),
    });

    const storyUrl = `${storybookUrl}/iframe.html?id=${storyId}&viewMode=story`;

    try {
      // Navigate to the story's iframe
      await page.goto(storyUrl, {
        waitUntil: 'networkidle',
        timeout: 10_000,
      });

      // Wait for the story to load
      await page.waitForLoadState('networkidle');

      // Wait for the body to load
      await page.waitForSelector('body', { timeout: 10_000 });

      await page.waitForLoadState('networkidle');

      // Prevent scrollbars and scroll-induced size changes in the story iframe
      await page.evaluate(() => {
        const html = document.documentElement;
        const body = document.body;
        if (html) html.style.overflow = 'hidden';
        if (body) body.style.overflow = 'hidden';
      });

      // Wait for content size to stabilize by sampling size three times
      await page.evaluate(async () => {
        const measure = (): string => {
          const se = document.scrollingElement || document.documentElement;
          const h = Math.max(
            se?.scrollHeight ?? 0,
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
          );
          const w = Math.max(
            se?.scrollWidth ?? 0,
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          );
          return `${w}x${h}`;
        };

        const sleep = (ms: number): Promise<void> =>
          new Promise((resolve) => setTimeout(resolve, ms));

        const a = measure();
        await sleep(150);
        const b = measure();
        await sleep(150);
        const c = measure();
        // Returning a value is fine, caller does not use it
        return a === b && b === c;
      });

      // Take screenshot and compare with baseline
      const sanitizedStoryId = storyId.replace(/[^a-zA-Z0-9]/g, '-');
      await expect(page).toHaveScreenshot(`${sanitizedStoryId}.png`, {
        animations: 'disabled',
      });
    } catch (error) {
      console.error(storyUrl);
      if (error instanceof Error && error.message.includes('Screenshot comparison failed')) {
        console.log(`\n💡 To update this snapshot, run:`);
        console.log(`   npm run test:visual-regression:update -- --grep "${storyId}"`);
      }
      throw error; // Re-throw to fail the test
    }
  }
});
