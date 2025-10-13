import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { expect, test, type Page } from '@playwright/test';
import chalk from 'chalk';

const defaultViewportSizes: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1024, height: 768 },
};
const defaultViewportKey = 'desktop';

const storybookUrl = process.env.STORYBOOK_URL || 'http://localhost:9009';
const projectRoot = process.env.ORIGINAL_CWD || process.cwd();

async function disableAnimations(page: Page): Promise<void> {
  // Respect reduced motion globally
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  } catch {
    /* noop */
  }

  // No project-specific selector hiding by default

  // Note: actual pausing/resetting of SVG SMIL animations is done after the story loads
}

type ReadyOptions = {
  overlayTimeout: number;
  stabilizeInterval: number;
  stabilizeAttempts: number;
};

async function waitForStoryReady(page: Page, opts?: ReadyOptions): Promise<void> {
  const overlayTimeout =
    opts?.overlayTimeout ?? parseInt(process.env.SVR_OVERLAY_TIMEOUT || '5000', 10);
  const stabilizeInterval =
    opts?.stabilizeInterval ?? parseInt(process.env.SVR_STABILIZE_INTERVAL || '200', 10);
  const stabilizeAttempts =
    opts?.stabilizeAttempts ?? parseInt(process.env.SVR_STABILIZE_ATTEMPTS || '20', 10);
  // Make sure the canvas container exists
  const waitTimeout = parseInt(process.env.SVR_WAIT_TIMEOUT || '30000', 10);
  await page.waitForSelector('#storybook-root', { state: 'attached', timeout: waitTimeout });

  // Try to wait for Storybook's preparing overlays to go away
  try {
    await page.waitForSelector('.sb-preparing-story, .sb-preparing-docs', {
      state: 'hidden',
      timeout: overlayTimeout,
    });
  } catch {
    // If they don't hide in time, force-hide them and continue
    await page.evaluate(() => {
      for (const sel of ['.sb-preparing-story', '.sb-preparing-docs']) {
        document.querySelectorAll(sel).forEach((el) => {
          (el as HTMLElement).style.display = 'none';
          (el as HTMLElement).setAttribute('aria-hidden', 'true');
        });
      }
    });
  }

  // Wait for loading spinners to disappear if enabled
  await waitForLoadingSpinners(page);

  // If Storybook shows error/nopreview wrappers, continue; we only care the canvas is visually present
  // Least fragile heuristic: any visible descendant in #storybook-root OR non-zero size of the root
  const isVisuallyReady = async () =>
    page.evaluate(() => {
      const root = document.querySelector('#storybook-root') as HTMLElement | null;
      if (!root) return false;
      const rr = root.getBoundingClientRect();
      if (rr.width > 0 && rr.height > 0) return true;
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      for (const el of root.querySelectorAll('*')) {
        if (isVisible(el)) return true;
      }
      return false;
    });

  for (let attempt = 0; attempt < stabilizeAttempts; attempt++) {
    if (await isVisuallyReady()) return;
    await page.waitForTimeout(stabilizeInterval);
  }

  throw new Error('Story canvas did not stabilize');
}

async function waitForLoadingSpinners(page: Page): Promise<void> {
  // Focus on more specific loading indicator selectors to avoid hiding legitimate content
  const spinnerSelectors = [
    '.sb-loader', // Storybook's own loader
  ];

  const spinnerTimeout = 5000; // Reduced timeout to 5 seconds

  // Wait for loading spinners to disappear
  for (const selector of spinnerSelectors) {
    try {
      // Check if element exists and is visible before waiting
      const element = await page.$(selector);
      if (!element) continue;

      const isVisible = await element.isVisible();
      if (!isVisible) continue;

      // Wait for the element to become hidden
      await page.waitForSelector(selector, {
        state: 'hidden',
        timeout: spinnerTimeout,
      });
    } catch {
      // Only hide elements that are clearly loading indicators
      await page.evaluate((sel) => {
        const elements = document.querySelectorAll(sel);
        elements.forEach((el) => {
          const element = el as HTMLElement;
          const text = element.textContent?.toLowerCase() || '';
          const className = element.className.toLowerCase();

          // Only hide if it's clearly a loading indicator
          if (
            className.includes('loading') ||
            className.includes('spinner') ||
            text.includes('loading') ||
            text.includes('please wait') ||
            element.getAttribute('role') === 'progressbar' ||
            element.getAttribute('data-testid')?.includes('loading') ||
            element.getAttribute('data-testid')?.includes('spinner')
          ) {
            element.style.display = 'none';
            element.setAttribute('aria-hidden', 'true');
          }
        });
      }, selector);
    }
  }

  // Wait for storybook-root to have actual content
  await page.waitForFunction(
    () => {
      const root = document.querySelector('#storybook-root');
      if (!root) return false;

      // Check if root has visible content
      const rect = root.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;

      // Check for visible child elements
      const children = root.querySelectorAll('*');
      for (const child of children) {
        const childRect = child.getBoundingClientRect();
        const style = window.getComputedStyle(child as HTMLElement);

        if (
          childRect.width > 0 &&
          childRect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          style.opacity !== '0'
        ) {
          return true;
        }
      }

      return false;
    },
    { timeout: 10000 },
  );

  // Add a small delay to ensure content is fully loaded and rendered
  await page.waitForTimeout(1000);

  // Wait for page to stabilize (no layout changes) - be lenient to avoid test failures
  try {
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

      // Try to stabilize, but don't fail if it doesn't work perfectly
      const a = measure();
      await sleep(100);
      const b = measure();
      await sleep(100);
      const c = measure();

      // If measurements are not stable, wait a bit more but don't fail
      if (a !== b || b !== c) {
        await sleep(200);
        // Just proceed - don't block the test
      }

      return true;
    });
  } catch (error) {
    // If stabilization fails, just continue - don't block the test
    console.warn(
      'Page stabilization check failed, proceeding anyway:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function _parseJsonEnv<T>(key: string, fallback: T): T {
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

type IndexEntries = Record<
  string,
  { type?: string; importPath?: string; title?: string; name?: string }
>;

function isIndexWithEntries(value: unknown): value is { entries: IndexEntries } {
  return (
    !!value &&
    typeof value === 'object' &&
    'entries' in value &&
    typeof (value as { entries?: unknown }).entries === 'object'
  );
}

function arraysFromIndex(index: unknown): {
  storyIds: string[];
  storyImportPaths: Record<string, string>;
  storyDisplayNames: Record<string, string>;
} {
  const entries: IndexEntries = isIndexWithEntries(index) ? index.entries : {};
  const storyIds = Object.keys(entries).filter((id) => entries[id]?.type === 'story');
  const storyImportPaths: Record<string, string> = {};
  const storyDisplayNames: Record<string, string> = {};
  for (const id of storyIds) {
    const entry = entries[id];
    if (entry && typeof entry.importPath === 'string') storyImportPaths[id] = entry.importPath;
    const human =
      entry && (entry.title || entry.name)
        ? `${entry.title ?? ''}${entry.title && entry.name ? ' › ' : ''}${entry.name ?? ''}`
        : id;
    storyDisplayNames[id] = human || id;
  }
  return { storyIds, storyImportPaths, storyDisplayNames };
}

async function discoverStories(): Promise<{
  storyIds: string[];
  storyImportPaths: Record<string, string>;
  storyDisplayNames: Record<string, string>;
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
      return { storyIds: [], storyImportPaths: {}, storyDisplayNames: {} };
    }
  }
}

const { storyIds, storyImportPaths, storyDisplayNames } = await discoverStories();

// Optionally limit to only stories missing a baseline snapshot when update runs with --missing-only
function filterMissingBaselines(stories: string[]): string[] {
  if (process.env.SVR_MISSING_ONLY !== 'true') return stories;
  const snapshotsDir = join(projectRoot, 'visual-regression', 'snapshots');
  return stories.filter((id) => {
    const sanitized = id.replace(/[^a-zA-Z0-9]/g, '-');
    const filePath = join(snapshotsDir, `${sanitized}.png`);
    return !existsSync(filePath);
  });
}

// Apply filtering based on CLI options
function filterStories(stories: string[]): string[] {
  let filtered = [...stories];

  // Apply include patterns
  if (process.env.STORYBOOK_INCLUDE) {
    const includePatterns = process.env.STORYBOOK_INCLUDE.split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    filtered = filtered.filter((storyId) => {
      const displayName = storyDisplayNames[storyId] || '';
      // Check if any pattern matches storyId or displayName (case-insensitive)
      return includePatterns.some((pattern) => {
        const lowerPattern = pattern.toLowerCase();
        const lowerStoryId = storyId.toLowerCase();
        const lowerDisplayName = displayName.toLowerCase();

        // Check if pattern contains glob characters, if not treat as literal string
        const hasGlobChars = /[*?[\]{}]/.test(pattern);

        if (hasGlobChars) {
          // Use glob pattern matching for patterns with glob characters
          try {
            // Convert glob pattern to regex for substring matching
            // Replace * with .* for "any characters" and escape other special chars
            const regexPattern = lowerPattern
              .replace(/\*/g, '.*')
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\\\.\*/g, '.*'); // Fix: don't escape the .* we just created
            const regex = new RegExp(regexPattern, 'i');

            const storyIdMatch = regex.test(lowerStoryId);
            const displayNameMatch = regex.test(lowerDisplayName);
            const matches = storyIdMatch || displayNameMatch;

            return matches;
          } catch {
            // Fallback to simple includes matching
            const storyIdMatch = lowerStoryId.includes(lowerPattern);
            const displayNameMatch = lowerDisplayName.includes(lowerPattern);
            const matches = storyIdMatch || displayNameMatch;

            return matches;
          }
        } else {
          // Use simple includes matching for literal strings
          const storyIdMatch = lowerStoryId.includes(lowerPattern);
          const displayNameMatch = lowerDisplayName.includes(lowerPattern);
          const matches = storyIdMatch || displayNameMatch;

          return matches;
        }
      });
    });
  }

  // Apply exclude patterns
  if (process.env.STORYBOOK_EXCLUDE) {
    const excludePatterns = process.env.STORYBOOK_EXCLUDE.split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    filtered = filtered.filter((storyId) => {
      const displayName = storyDisplayNames[storyId] || '';
      // Check if any pattern matches storyId or displayName (case-insensitive)
      return !excludePatterns.some((pattern) => {
        const lowerPattern = pattern.toLowerCase();
        const lowerStoryId = storyId.toLowerCase();
        const lowerDisplayName = displayName.toLowerCase();

        // Try glob pattern matching first, fallback to includes for backward compatibility
        try {
          // Convert glob pattern to regex for substring matching
          const regexPattern = lowerPattern
            .replace(/\*/g, '.*')
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\\\.\*/g, '.*'); // Fix: don't escape the .* we just created
          const regex = new RegExp(regexPattern, 'i');
          return regex.test(lowerStoryId) || regex.test(lowerDisplayName);
        } catch {
          // Fallback to simple includes matching for backward compatibility
          return lowerStoryId.includes(lowerPattern) || lowerDisplayName.includes(lowerPattern);
        }
      });
    });
  }

  // Apply grep pattern (regex)
  if (process.env.STORYBOOK_GREP) {
    try {
      const regex = new RegExp(process.env.STORYBOOK_GREP, 'i');
      filtered = filtered.filter((storyId) => regex.test(storyId));
    } catch {
      console.warn(`Invalid regex pattern: ${process.env.STORYBOOK_GREP}`);
    }
  }

  return filtered;
}

const filteredStoryIds = filterMissingBaselines(filterStories(storyIds));

test.describe('Visual Regression', () => {
  test.describe.configure({ mode: 'parallel' });

  if (filteredStoryIds.length === 0) {
    test('No stories discovered', () => {
      throw new Error(
        'No stories were discovered in Storybook. Ensure Storybook is running or build storybook-static first.',
      );
    });
    return;
  }

  for (const storyId of filteredStoryIds) {
    const humanTitle = `${storyDisplayNames[storyId] || storyId} [${storyId}]`;
    test(humanTitle, async ({ page }) => {
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
      await disableAnimations(page);

      await page.clock.install({
        time: new Date('2024-01-15T10:30:00.000Z'),
      });

      // Normalize base to avoid double slashes causing 404s (e.g. http://localhost:6006//iframe.html)
      const base = storybookUrl.replace(/\/$/, '');
      const candidateUrls = [
        `${base}/iframe.html?id=${storyId}&viewMode=story`,
        `${base}/iframe.html?path=/story/${storyId}`,
      ];
      let storyUrl = candidateUrls[0];
      if (process.env.SVR_DEBUG === 'true') {
        console.log(`SVR: story id: ${storyId}`);
        console.log(`SVR: url: ${storyUrl}`);
      }

      try {
        const navTimeout = parseInt(process.env.SVR_NAV_TIMEOUT || '10000', 10);
        const waitTimeout = parseInt(process.env.SVR_WAIT_TIMEOUT || '30000', 10);
        const overlayTimeout = parseInt(process.env.SVR_OVERLAY_TIMEOUT || '5000', 10);
        const stabilizeInterval = parseInt(process.env.SVR_STABILIZE_INTERVAL || '150', 10);
        const stabilizeAttempts = parseInt(process.env.SVR_STABILIZE_ATTEMPTS || '20', 10);

        let resp = await page.goto(storyUrl, {
          waitUntil: 'networkidle',
          timeout: navTimeout,
        });

        // Fail fast on bad HTTP responses
        if (!resp || !resp.ok()) {
          // Try alternative path-based URL used by some Storybook setups
          const altUrl = candidateUrls[1];
          if (storyUrl !== altUrl) {
            storyUrl = altUrl;
            resp = await page.goto(storyUrl, { waitUntil: 'networkidle', timeout: navTimeout });
            if (process.env.SVR_DEBUG === 'true') {
              console.log(`SVR: url (retry): ${storyUrl}`);
            }
          }
          if (!resp || !resp.ok()) {
            const status = resp ? `${resp.status()} ${resp.statusText()}` : 'no response';
            console.error(`Story URL (bad response): ${storyUrl}`);
            throw new Error(`Failed to load story: ${status}`);
          }
        }

        await page.waitForLoadState('networkidle');

        // Wait for Storybook to finish preparing the story and for the canvas to exist
        await page.waitForSelector('#storybook-root', { state: 'attached', timeout: waitTimeout });
        await waitForStoryReady(page, { overlayTimeout, stabilizeInterval, stabilizeAttempts });

        // Additional checks to ensure we're not on an error page
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

        // Optional heuristic: detect host 'Not Found' responses (off by default)
        if (process.env.SVR_NOT_FOUND_CHECK === 'true') {
          const retryDelay = parseInt(process.env.SVR_NOT_FOUND_RETRY_DELAY || '200', 10);
          // try twice separated by small delay in case canvas hasn't rendered yet
          for (let attempt = 0; attempt < 2; attempt++) {
            const bodyText = (await page.textContent('body')) || '';
            const isNotFound = /not\s*found/i.test(bodyText) || /\b404\b/.test(bodyText);
            if (!isNotFound) break;
            if (attempt === 0) {
              await page.waitForTimeout(retryDelay);
              continue;
            }
            console.error(chalk.red(`Story URL (content says Not Found): ${storyUrl}`));
            throw new Error('Host page reports Not Found');
          }
        }

        // Ensure some visible content exists inside storybook root (root itself may be height: 0)
        await page.waitForFunction(
          () => {
            const root = document.querySelector('#storybook-root');
            if (!root) return false;
            const nodes = root.querySelectorAll('*');
            for (const el of Array.from(nodes)) {
              const r = (el as HTMLElement).getBoundingClientRect();
              const s = getComputedStyle(el as HTMLElement);
              if (
                r.width > 0 &&
                r.height > 0 &&
                s.visibility !== 'hidden' &&
                s.display !== 'none'
              ) {
                return true;
              }
            }
            return false;
          },
          { timeout: waitTimeout },
        );

        await page.evaluate(() => {
          const html = document.documentElement;
          const body = document.body;
          if (html) html.style.overflow = 'hidden';
          if (body) body.style.overflow = 'hidden';
        });

        const sanitizedStoryId = storyId.replace(/[^a-zA-Z0-9]/g, '-');
        const expectedPath = join(
          projectRoot,
          'visual-regression',
          'snapshots',
          `${sanitizedStoryId}.png`,
        );

        try {
          await expect(page).toHaveScreenshot(`${sanitizedStoryId}.png`);
        } catch (assertionError) {
          // Check if the snapshot file exists
          const snapshotExists = await import('fs').then((fs) =>
            fs.promises
              .access(expectedPath)
              .then(() => true)
              .catch(() => false),
          );

          // Print a spaced, aligned failure block
          const label = (k: string) => (k + ':').padEnd(10, ' ');

          if (!snapshotExists) {
            console.error('\n' + chalk.yellow('──────── Missing Snapshot ────────'));
            console.error(chalk.yellow(`${label('Story')}${storyId}`));
            console.error(chalk.yellow(`${label('URL')}${storyUrl}`));
            console.error(chalk.yellow(`${label('Missing')}${expectedPath}`));
            console.error(chalk.yellow('──────────────────────────────────────'));
            console.error(chalk.cyan('💡 To create the missing snapshot, run:'));
            console.error(
              chalk.cyan(`   storybook-visual-regression update --include "${storyId}"`),
            );
            console.error(chalk.yellow('──────────────────────────────────────\n'));
            throw new Error(
              `Snapshot doesn't exist for story '${storyId}'. Run 'storybook-visual-regression update --include "${storyId}"' to create it.`,
            );
          } else {
            console.error('\n' + chalk.red('──────── Screenshot Mismatch ────────'));
            console.error(chalk.red(`${label('Story')}${storyId}`));
            console.error(chalk.red(`${label('URL')}${storyUrl}`));
            console.error(
              chalk.red(
                `${label('Reason')}${assertionError instanceof Error ? assertionError.message : String(assertionError)}`,
              ),
            );
            // Helpful paths
            const resultsRoot = process.env.PLAYWRIGHT_OUTPUT_DIR
              ? `${process.env.PLAYWRIGHT_OUTPUT_DIR}/results`
              : join(projectRoot, 'visual-regression', 'results');
            console.error(chalk.red(`${label('Expected')}${expectedPath}`));
            console.error(chalk.red(`${label('Results')}${resultsRoot}`));
            console.error(chalk.red('──────────────────────────────────────\n'));
            throw new Error(
              `Screenshot mismatch for story '${storyId}'. Snapshot: ${sanitizedStoryId}.png`,
            );
          }
        }
      } catch (error) {
        // Emit the URL and reason in a spaced, aligned block
        const label = (k: string) => (k + ':').padEnd(10, ' ');
        console.error('\n' + chalk.red('──────── Test Failed ────────'));
        console.error(chalk.red(`${label('Story')}${storyId}`));
        console.error(chalk.red(`${label('URL')}${storyUrl}`));
        console.error(
          chalk.red(`${label('Reason')}${error instanceof Error ? error.message : String(error)}`),
        );
        console.error(chalk.red('────────────────────────────\n'));
        throw error;
      }
    });
  }
});
