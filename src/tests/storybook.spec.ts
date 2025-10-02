import { readFileSync } from 'fs';
import { join } from 'path';

import { expect, test } from '@playwright/test';

const defaultViewportSizes: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1024, height: 768 },
};
const defaultViewportKey = 'desktop';

const storybookUrl = process.env.STORYBOOK_URL || 'http://localhost:9009';
const projectRoot = process.env.ORIGINAL_CWD || process.cwd();

function parseJsonEnv<T>(key: string, fallback: T): T {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn(
      `⚠️  Unable to parse environment variable ${key}:`,
      error instanceof Error ? error.message : String(error),
    );
    return fallback;
  }
}

function arraysFromIndex(index: any): {
  storyIds: string[];
  storyImportPaths: Record<string, string>;
} {
  const entries = (index && typeof index === 'object' && index.entries) || {};
  const storyIds = Object.keys(entries).filter((id) => entries[id]?.type === 'story');
  const storyImportPaths: Record<string, string> = {};
  for (const id of storyIds) {
    const entry = entries[id];
    if (entry && typeof entry.importPath === 'string') storyImportPaths[id] = entry.importPath;
  }
  return { storyIds, storyImportPaths };
}

async function discoverStories(): Promise<{
  storyIds: string[];
  storyImportPaths: Record<string, string>;
}> {
  // Try server first (webServer should already be ready)
  const base = storybookUrl.replace(/\/$/, '');
  try {
    const resp = await fetch(`${base}/index.json`, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`index.json returned ${resp.status}`);
    const json = await resp.json();
    return arraysFromIndex(json);
  } catch {
    // Fallback to static export if present
    try {
      const raw = readFileSync(join(projectRoot, 'storybook-static', 'index.json'), 'utf8');
      const json = JSON.parse(raw);
      return arraysFromIndex(json);
    } catch {
      return { storyIds: [], storyImportPaths: {} };
    }
  }
}

const { storyIds, storyImportPaths } = await discoverStories();

test.describe('Storybook Visual Regression', () => {
  test.describe.configure({ mode: 'parallel' });

  if (storyIds.length === 0) {
    test('No stories discovered', () => {
      throw new Error(
        'No stories were discovered in Storybook. Ensure Storybook is running or build storybook-static first.',
      );
    });
    return;
  }

  for (const storyId of storyIds) {
    test(storyId, async ({ page }) => {
      let viewportKey = defaultViewportKey;
      const importPath = storyImportPaths[storyId];

      if (importPath) {
        try {
          const storySource = readFileSync(join(projectRoot, importPath), 'utf8');
          const match = storySource.match(
            /globals\s*:\s*\{[^}]*viewport\s*:\s*\{[^}]*value\s*:\s*['"](\w+)['"][^}]*\}[^}]*\}/,
          );
          if (match && match[1] && defaultViewportSizes[match[1]]) {
            viewportKey = match[1];
          }
        } catch {
          // Ignore read/parse errors and keep default viewport
        }
      }

      const size = defaultViewportSizes[viewportKey] || defaultViewportSizes[defaultViewportKey];
      await page.setViewportSize(size);

      await page.clock.install({
        time: new Date('2024-01-15T10:30:00.000Z'),
      });

      const storyUrl = `${storybookUrl}/iframe.html?id=${storyId}&viewMode=story`;

      await page.goto(storyUrl, {
        waitUntil: 'networkidle',
        timeout: 10_000,
      });

      await page.waitForLoadState('networkidle');

      // Wait for body to be visible (not hidden with error display)
      await page.waitForSelector('body:not(.sb-show-errordisplay)', { timeout: 15_000 });

      // Additional check to ensure we're not on an error page
      const isErrorPage = await page.evaluate(() => {
        return (
          document.body.classList.contains('sb-show-errordisplay') ||
          document.querySelector('[data-testid="error"]') !== null ||
          document.querySelector('.sb-show-errordisplay') !== null
        );
      });

      if (isErrorPage) {
        throw new Error('Storybook is displaying an error page');
      }

      await page.evaluate(() => {
        const html = document.documentElement;
        const body = document.body;
        if (html) html.style.overflow = 'hidden';
        if (body) body.style.overflow = 'hidden';
      });

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
        return a === b && b === c;
      });

      const sanitizedStoryId = storyId.replace(/[^a-zA-Z0-9]/g, '-');
      await expect(page).toHaveScreenshot(`${sanitizedStoryId}.png`, {
        animations: 'disabled',
      });
    });
  }
});
