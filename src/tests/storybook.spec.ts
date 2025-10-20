import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { expect, test, type Page } from '@playwright/test';
import chalk from 'chalk';
import { loadRuntimeOptions } from '../runtime/runtime-options.js';

const runtimeOptions = loadRuntimeOptions();

const defaultViewportSizes: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1024, height: 768 },
};
const defaultViewportKey = 'desktop';

const storybookUrl = runtimeOptions.storybookUrl;
const projectRoot = runtimeOptions.originalCwd;
const snapshotsDirectory = runtimeOptions.visualRegression.snapshotPath;
const resultsDirectory = runtimeOptions.visualRegression.resultsPath;
const includePatterns = runtimeOptions.include;
const excludePatterns = runtimeOptions.exclude;
const grepPattern = runtimeOptions.grep;
const debugEnabled = runtimeOptions.debug;

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
  const overlayTimeout = opts?.overlayTimeout ?? runtimeOptions.overlayTimeout;
  const stabilizeInterval = opts?.stabilizeInterval ?? runtimeOptions.stabilizeInterval;
  const stabilizeAttempts = opts?.stabilizeAttempts ?? runtimeOptions.stabilizeAttempts;
  const debugEnabled = runtimeOptions.debug;
  // Make sure the canvas container exists
  const waitTimeout = runtimeOptions.waitTimeout;
  await page.waitForSelector('#storybook-root', { state: 'attached', timeout: waitTimeout });

  // Immediately force-hide Storybook's preparing overlays since they often don't hide properly
  // This is more reliable than waiting for them to hide naturally
  await page.evaluate(() => {
    const overlaySelectors = [
      '.sb-preparing-story',
      '.sb-preparing-docs',
      '.sb-loader', // Also hide any standalone loaders
    ];
    for (const sel of overlaySelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        (el as HTMLElement).style.display = 'none';
        (el as HTMLElement).setAttribute('aria-hidden', 'true');
      });
    }
  });

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

  // Try to detect when story is visually ready, but don't block if it doesn't stabilize
  let isReady = false;
  for (let attempt = 0; attempt < stabilizeAttempts; attempt++) {
    if (await isVisuallyReady()) {
      isReady = true;
      break;
    }
    await page.waitForTimeout(stabilizeInterval);
  }

  // If story didn't become visually ready, log warning but continue
  // The story might be ready but our heuristic failed, or it might be blank intentionally
  if (!isReady && debugEnabled) {
    console.warn('Story did not become visually ready, but proceeding anyway');
  }
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

  // Wait for storybook-root to have actual content (reduced timeout for faster feedback)
  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector('#storybook-root');
        if (!root) return false;

        // Check if root has visible content
        const rect = root.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;

        // Check for visible child elements (limit check to first 50 for performance)
        const children = Array.from(root.querySelectorAll('*')).slice(0, 50);
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
      { timeout: 5000 }, // Reduced from 10s to 5s
    );
  } catch {
    // If content visibility check times out, proceed anyway
    // The story might be ready but our heuristic failed
  }

  // Add a small delay to ensure content is fully loaded and rendered (configurable)
  const finalSettleMs = runtimeOptions.finalSettle;
  if (finalSettleMs > 0) {
    await page.waitForTimeout(finalSettleMs);
  }

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
  storySnapshotPaths: Record<string, string>;
} {
  const entries: IndexEntries = isIndexWithEntries(index) ? index.entries : {};
  const storyIds = Object.keys(entries).filter((id) => entries[id]?.type === 'story');
  const storyImportPaths: Record<string, string> = {};
  const storyDisplayNames: Record<string, string> = {};
  const storySnapshotPaths: Record<string, string> = {};
  for (const id of storyIds) {
    const entry = entries[id];
    if (entry && typeof entry.importPath === 'string') storyImportPaths[id] = entry.importPath;
    const human =
      entry && (entry.title || entry.name)
        ? `${entry.title ?? ''}${entry.title && entry.name ? ' › ' : ''}${entry.name ?? ''}`
        : id;
    storyDisplayNames[id] = human || id;

    // Use story ID directly as snapshot filename
    storySnapshotPaths[id] = `${id}.png`;
  }
  return { storyIds, storyImportPaths, storyDisplayNames, storySnapshotPaths };
}

async function discoverStories(): Promise<{
  storyIds: string[];
  storyImportPaths: Record<string, string>;
  storyDisplayNames: Record<string, string>;
  storySnapshotPaths: Record<string, string>;
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
      return { storyIds: [], storyImportPaths: {}, storyDisplayNames: {}, storySnapshotPaths: {} };
    }
  }
}

const { storyIds, storyImportPaths, storyDisplayNames, storySnapshotPaths } =
  await discoverStories();

// Optionally limit to only stories missing a baseline snapshot when update runs with --missing-only
function filterMissingBaselines(stories: string[]): string[] {
  if (!runtimeOptions.missingOnly) return stories;
  const snapshotsDir = runtimeOptions.visualRegression.snapshotPath;
  return stories.filter((id) => {
    const snapshotPath = storySnapshotPaths[id];
    if (!snapshotPath) return true; // Include if no path generated
    const filePath = join(snapshotsDir, snapshotPath);
    return !existsSync(filePath);
  });
}

// Apply filtering based on CLI options
function filterStories(stories: string[]): string[] {
  let filtered = [...stories];

  // Apply include patterns
  if (includePatterns.length > 0) {
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
  if (excludePatterns.length > 0) {
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
  if (grepPattern) {
    try {
      const regex = new RegExp(grepPattern, 'i');
      filtered = filtered.filter((storyId) => regex.test(storyId));
    } catch {
      console.warn(`Invalid regex pattern: ${grepPattern}`);
    }
  }

  return filtered;
}

const filteredStoryIds = filterMissingBaselines(filterStories(storyIds));

test.describe('Visual Regression', () => {
  test.describe.configure({ mode: 'parallel' });

  if (filteredStoryIds.length === 0) {
    // Check if this is due to filtering or actual discovery failure
    if (storyIds.length === 0) {
      test('No stories discovered', () => {
        throw new Error(
          'No stories were discovered in Storybook. Ensure Storybook is running or build storybook-static first.',
        );
      });
    } else {
      // Stories were discovered but filtered out
      if (runtimeOptions.missingOnly) {
        console.log(
          '✅ All stories already have snapshots. Nothing to update with --missing-only.',
        );
      } else {
        console.log(
          'ℹ️  No stories match the current filters. Adjust your include/exclude/grep patterns.',
        );
      }
      // Don't create any tests - just log the message and exit
    }
    return;
  }

  for (const storyId of filteredStoryIds) {
    const humanTitle = `${storyDisplayNames[storyId] || storyId} [${storyId}]`;
    test(humanTitle, async ({ page }, _testInfo) => {
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
      if (debugEnabled) {
        console.log(`SVR: story id: ${storyId}`);
        console.log(`SVR: url: ${storyUrl}`);
      }

      try {
        const navTimeout = runtimeOptions.navTimeout;
        const waitTimeout = runtimeOptions.waitTimeout;
        const overlayTimeout = runtimeOptions.overlayTimeout;
        const stabilizeInterval = runtimeOptions.stabilizeInterval;
        const stabilizeAttempts = runtimeOptions.stabilizeAttempts;
        const waitUntilOption = runtimeOptions.waitUntil;

        const operationStartTime = Date.now();
        if (debugEnabled) {
          console.log(`[${storyId}] Starting navigation at ${operationStartTime}`);
        }

        // Navigate to the story with a simple domcontentloaded wait
        let resp = await page.goto(storyUrl, {
          waitUntil: 'domcontentloaded',
          timeout: navTimeout,
        });

        if (debugEnabled) {
          console.log(`[${storyId}] Navigation completed in ${Date.now() - operationStartTime}ms`);
        }

        // Wait for all resources to finish loading using Performance API
        // This is simpler and more reliable than waitUntil: 'load'
        const resourceWaitStart = Date.now();
        const resourceSettleMs = runtimeOptions.resourceSettle;
        try {
          await page.waitForFunction(
            (settleTime) => {
              // Check if all resources have finished loading
              const resources = performance.getEntriesByType(
                'resource',
              ) as PerformanceResourceTiming[];
              const pendingResources = resources.filter(
                (r) => !r.responseEnd || Date.now() - r.responseEnd < (settleTime as number),
              );
              return pendingResources.length === 0;
            },
            resourceSettleMs,
            { timeout: waitTimeout },
          );
          if (debugEnabled) {
            console.log(`[${storyId}] All resources loaded in ${Date.now() - resourceWaitStart}ms`);
          }
        } catch {
          // Resources didn't all finish, but the page is likely ready anyway
          if (debugEnabled) {
            console.log(
              `[${storyId}] Resource wait timed out after ${Date.now() - resourceWaitStart}ms, proceeding`,
            );
          }
        }

        // Wait for fonts specifically - critical for visual consistency
        const fontWaitStart = Date.now();
        try {
          await page.evaluate(() => document.fonts.ready);
          if (debugEnabled) {
            console.log(`[${storyId}] Fonts ready in ${Date.now() - fontWaitStart}ms`);
          }
        } catch {
          if (debugEnabled) {
            console.log(
              `[${storyId}] Font wait timed out after ${Date.now() - fontWaitStart}ms, proceeding`,
            );
          }
        }

        // Fail fast on bad HTTP responses
        if (!resp || !resp.ok()) {
          // Try alternative path-based URL used by some Storybook setups
          const altUrl = candidateUrls[1];
          if (storyUrl !== altUrl) {
            storyUrl = altUrl;
            resp = await page.goto(storyUrl, { waitUntil: waitUntilOption, timeout: navTimeout });
            if (debugEnabled) {
              console.log(`SVR: url (retry): ${storyUrl}`);
            }
          }
          if (!resp || !resp.ok()) {
            const status = resp ? `${resp.status()} ${resp.statusText()}` : 'no response';
            console.error(`Story URL (bad response): ${storyUrl}`);
            throw new Error(`Failed to load story: ${status}`);
          }
        }
        // Avoid redundant global networkidle wait; readiness checks below guard stability

        // Wait for Storybook to finish preparing the story and for the canvas to exist
        const beforeRootWait = Date.now();
        if (debugEnabled) {
          console.log(`[${storyId}] Waiting for #storybook-root...`);
        }
        await page.waitForSelector('#storybook-root', { state: 'attached', timeout: waitTimeout });
        if (debugEnabled) {
          console.log(`[${storyId}] Found #storybook-root in ${Date.now() - beforeRootWait}ms`);
        }

        const beforeReadyWait = Date.now();
        if (debugEnabled) {
          console.log(`[${storyId}] Waiting for story to be ready...`);
        }
        await waitForStoryReady(page, { overlayTimeout, stabilizeInterval, stabilizeAttempts });
        if (debugEnabled) {
          console.log(`[${storyId}] Story ready in ${Date.now() - beforeReadyWait}ms`);
        }

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
        if (runtimeOptions.notFoundCheck) {
          const retryDelay = runtimeOptions.notFoundRetryDelay;
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
        // This check is lenient - if it times out, we proceed anyway since the page loaded successfully
        try {
          await page.waitForFunction(
            () => {
              const root = document.querySelector('#storybook-root');
              if (!root) return false;

              // First check: does root itself have dimensions?
              const rootRect = root.getBoundingClientRect();
              if (rootRect.width > 0 && rootRect.height > 0) {
                return true;
              }

              // Second check: does any child have dimensions?
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
            { timeout: 5000 }, // Reduced from waitTimeout to 5s since this is a sanity check
          );
        } catch {
          // If this check times out, log a warning but continue
          // The page has already loaded successfully and passed other checks
          if (debugEnabled) {
            console.warn(
              `Visible content check timed out for ${storyId}, proceeding anyway (page loaded successfully)`,
            );
          }
        }

        await page.evaluate(() => {
          const html = document.documentElement;
          const body = document.body;
          if (html) html.style.overflow = 'hidden';
          if (body) body.style.overflow = 'hidden';
        });

        // Get the snapshot filename using story ID
        const snapshotFileName = storySnapshotPaths[storyId] || `${storyId}.png`;

        // Use the filename directly (no folder structure)
        const snapshotPathParts = [snapshotFileName];

        // Construct the full snapshot path for validation
        const snapshotPath = join(snapshotsDirectory, snapshotFileName);
        if (debugEnabled) {
          console.log(`SVR: snapshot path resolved to ${snapshotPath}`);
        }

        console.log(
          `About to take screenshot for ${storyId}, update mode: ${runtimeOptions.updateSnapshots}`,
        );
        try {
          // Verify page is still valid before attempting screenshot
          if (page.isClosed()) {
            throw new Error('Page was closed before screenshot could be taken');
          }

          await expect(page).toHaveScreenshot(snapshotPathParts, {
            fullPage: Boolean(runtimeOptions.fullPage),
          });
        } catch (assertionError) {
          // Check if this is a TypeError from buffer operations (usually after timeout)
          const errorMessage =
            assertionError instanceof Error ? assertionError.message : String(assertionError);
          const isBufferError =
            errorMessage.includes('The "data" argument must be of type string') ||
            errorMessage.includes('Received undefined');

          if (isBufferError) {
            // This typically happens when the page times out or is in an invalid state
            throw new Error(
              `Failed to capture screenshot (page may have timed out or is in an invalid state): ${errorMessage}`,
            );
          }

          // Check if we're in update mode - if so, let Playwright handle snapshot creation
          const isUpdateMode = runtimeOptions.updateSnapshots;
          console.log(`Screenshot failed for ${storyId}, isUpdateMode: ${isUpdateMode}`);

          if (isUpdateMode) {
            // In update mode, re-throw the original assertion error to let Playwright create the snapshot
            throw assertionError;
          }

          // Check if the snapshot file exists
          const snapshotExists = await import('fs').then((fs) =>
            fs.promises
              .access(snapshotPath)
              .then(() => true)
              .catch(() => false),
          );

          // Print a spaced, aligned failure block
          const label = (k: string) => (k + ':').padEnd(10, ' ');

          if (!snapshotExists) {
            console.error('\n' + chalk.yellow('──────── Missing Snapshot ────────'));
            console.error(chalk.yellow(`${label('Story')}${storyId}`));
            console.error(chalk.yellow(`${label('URL')}${storyUrl}`));
            console.error(chalk.yellow(`${label('Missing')}${snapshotPath}`));
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
            console.error(chalk.red(`${label('Reason')}${errorMessage}`));
            // Helpful paths
            const resultsRoot = resultsDirectory;
            console.error(chalk.red(`${label('Expected')}${snapshotPath}`));
            console.error(chalk.red(`${label('Results')}${resultsRoot}`));
            console.error(chalk.red('──────────────────────────────────────\n'));
            throw new Error(
              `Screenshot mismatch for story '${storyId}'. Snapshot: ${snapshotFileName}`,
            );
          }
        }

        if (runtimeOptions.updateSnapshots) {
          const snapshotExists = await import('fs').then((fs) =>
            fs.promises
              .access(snapshotPath)
              .then(() => true)
              .catch(() => false),
          );

          if (!snapshotExists) {
            throw new Error(
              `Playwright reported success but no snapshot was written for '${storyId}' at ${snapshotPath}.`,
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
