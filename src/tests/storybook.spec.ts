import { readFileSync } from 'fs';
import { join } from 'path';

import { expect, test } from '@playwright/test';

// Get story IDs from Storybook dev server
let storyIds: string[] = [];
// Map storyId -> importPath (path to the .stories.tsx file) when available
const storyImportPaths: Record<string, string> = {};
// Viewport sizes mirrored from .storybook/preview.tsx
const viewportSizes: Record<string, { width: number; height: number }> = {
  unattended: { width: 1024, height: 768 },
  attended: { width: 1360, height: 768 },
  customer: { width: 1920, height: 1200 },
};
const defaultViewportKey = 'unattended';

try {
  // Try to get stories from dev server first
  const response = await fetch('http://localhost:9009/index.json');
  if (response.ok) {
    const indexData = await response.json();
    const entries = indexData.entries || {};
    storyIds = Object.keys(entries).filter((id) => entries[id].type === 'story');
    for (const id of storyIds) {
      const entry = entries[id];
      if (entry && typeof entry.importPath === 'string') {
        storyImportPaths[id] = entry.importPath;
      }
    }
  } else {
    throw new Error('Dev server not available');
  }
} catch (error) {
  // Fallback to built files
  try {
    const indexFile = join(process.cwd(), 'storybook-static/index.json');
    const indexData = JSON.parse(readFileSync(indexFile, 'utf8'));
    const entries = indexData.entries || {};
    storyIds = Object.keys(entries).filter((id) => entries[id].type === 'story');
    for (const id of storyIds) {
      const entry = entries[id];
      if (entry && typeof entry.importPath === 'string') {
        storyImportPaths[id] = entry.importPath;
      }
    }
  } catch {
    console.error('Error reading Storybook data:', error);
    console.log('Make sure Storybook dev server is running or run "npm run build:ui" first');
    process.exit(1);
  }
}

storyIds.forEach((storyId: string) => {
  test(`${storyId}`, async ({ page }) => {
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
        if (match && match[1] && viewportSizes[match[1]]) {
          viewportKey = match[1];
        }
      } catch {
        // ignore read/parse errors and keep default
      }
    }

    const size = viewportSizes[viewportKey] || viewportSizes[defaultViewportKey];
    await page.setViewportSize(size);

    // Freeze time to ensure consistent timestamps and stable timer-based updates
    await page.clock.install({
      time: new Date('2024-01-15T10:30:00.000Z'),
    });

    const storyUrl = `http://localhost:9009/iframe.html?id=${storyId}&viewMode=story`;

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
      await expect(page).toHaveScreenshot(`${storyId.replace(/[^a-zA-Z0-9]/g, '-')}.png`, {
        animations: 'disabled',
      });
    } catch (error) {
      console.error(storyUrl);
      if (error instanceof Error && error.message.includes('Screenshot comparison failed')) {
        console.log(`\n💡 To update this snapshot, run:`);
        console.log(`   npm run test:visual-regression:update -- --grep "${storyId}"`);
      }
    }
  });
});
