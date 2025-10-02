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

const storyIds = parseJsonEnv<string[]>('STORYBOOK_STORY_IDS', []);
const storyImportPaths = parseJsonEnv<Record<string, string>>('STORYBOOK_IMPORT_PATHS', {});

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
      await page.waitForSelector('body', { timeout: 10_000 });

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
