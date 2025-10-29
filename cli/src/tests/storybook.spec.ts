import { readFileSync, existsSync, readdirSync, rmSync, promises as fsPromises } from 'fs';
import { join, dirname, relative } from 'path';

import { test, type Page } from '@playwright/test';
import chalk from 'chalk';
import { loadRuntimeOptions } from '../runtime/runtime-options.js';
import { createRequire } from 'module';

// Get odiff compare function from Node.js bindings
const req = createRequire(import.meta.url);
const { compare } = req('odiff-bin');

const runtimeOptions = loadRuntimeOptions();

// Default viewport sizes - these will be overridden by discovered configurations
const defaultViewportSizes: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1024, height: 768 },
};
const defaultViewportKey = 'desktop';

// Get viewport configurations from runtime options (discovered from Storybook)
const discoveredViewportSizes =
  runtimeOptions.visualRegression?.viewportSizes || defaultViewportSizes;
const effectiveDefaultViewport =
  runtimeOptions.visualRegression?.defaultViewport || defaultViewportKey;

const storybookUrl = runtimeOptions.storybookUrl;
const projectRoot = runtimeOptions.originalCwd;
const snapshotsDirectory = runtimeOptions.visualRegression.snapshotPath;
const resultsDirectory = runtimeOptions.visualRegression.resultsPath;
const includePatterns = runtimeOptions.include;
const excludePatterns = runtimeOptions.exclude;
const grepPattern = runtimeOptions.grep;
const debugEnabled = runtimeOptions.debug;

type ArtifactCleanupMode = 'all' | 'older';

/**
 * Safely create a directory, handling race conditions where multiple workers
 * might try to create the same directory simultaneously.
 */
async function ensureDirectoryExists(dirPath: string): Promise<void> {
  // Normalize the path to handle any weird characters
  const normalizedPath = dirPath;

  // Check if it already exists and is a directory
  try {
    const stats = await fsPromises.stat(normalizedPath);
    if (stats.isDirectory()) {
      return; // Already exists as a directory, we're good
    }
    // Exists but is not a directory - this is an error condition
    throw new Error(`Path exists but is not a directory: ${normalizedPath}`);
  } catch (error) {
    // If stat fails because path doesn't exist, that's expected - continue to create it
    const statError = error as { code?: string };
    if (statError.code !== 'ENOENT') {
      throw error;
    }
  }

  // Directory doesn't exist, create it with recursive flag to create all parents
  // Use a retry loop to handle race conditions where parent directories might be created/deleted
  let lastError: unknown;
  const maxRetries = 5;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Try to create the directory (recursive creates all parents)
      await fsPromises.mkdir(normalizedPath, { recursive: true });

      // Verify it was created successfully
      const stats = await fsPromises.stat(normalizedPath);
      if (stats.isDirectory()) {
        return; // Success!
      }
      throw new Error(
        `Failed to create directory: ${normalizedPath} (exists but is not a directory)`,
      );
    } catch (error) {
      const mkdirError = error as { code?: string };
      lastError = error;

      // If directory already exists (race condition with other workers), verify it's a directory
      if (mkdirError.code === 'EEXIST' || mkdirError.code === 'EINVAL') {
        // Wait a bit for the directory to be fully created by another worker
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));

        // Check if it exists now
        try {
          const stats = await fsPromises.stat(normalizedPath);
          if (stats.isDirectory()) {
            return; // Success - directory exists and is a directory
          }
          // Exists but isn't a directory
          throw new Error(`Path exists but is not a directory: ${normalizedPath}`);
        } catch (statError) {
          const statErr = statError as { code?: string };
          // If still doesn't exist, retry
          if (statErr.code === 'ENOENT' && attempt < maxRetries - 1) {
            continue;
          }
          // Otherwise propagate the error
          throw statError;
        }
      }

      // For ENOENT errors, retry (parent directory might not exist yet)
      if (mkdirError.code === 'ENOENT') {
        if (attempt < maxRetries - 1) {
          // Wait before retrying (exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          continue;
        }
      }

      // Check if directory was created by another process between our try and catch
      try {
        if (existsSync(normalizedPath)) {
          const stats = await fsPromises.stat(normalizedPath);
          if (stats.isDirectory()) {
            return; // Another worker created it, we're good
          }
        }
      } catch {
        // Ignore stat errors here
      }

      // If we've exhausted retries or it's not a retryable error, throw
      if (
        attempt >= maxRetries - 1 ||
        !['EEXIST', 'ENOENT', 'EINVAL'].includes(mkdirError.code || '')
      ) {
        const errorMsg = mkdirError instanceof Error ? mkdirError.message : String(mkdirError);
        throw new Error(
          `Failed to create directory ${normalizedPath} after ${attempt + 1} attempts: ${mkdirError.code || errorMsg}`,
        );
      }
    }
  }

  // Should never reach here, but just in case
  const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to create directory ${normalizedPath}: ${errorMsg}`);
}

/**
 * Recursively removes empty directories up to the results directory root.
 * Stops when reaching the results directory root to avoid removing it.
 */
async function removeEmptyDirectory(dir: string, rootDir: string): Promise<void> {
  try {
    // Stop if we've reached or passed the root directory
    if (dir === rootDir || !dir.startsWith(rootDir)) {
      return;
    }

    // Check if directory exists and is empty
    if (!existsSync(dir)) {
      return;
    }

    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0) {
      // Directory is empty, remove it
      rmSync(dir, { recursive: true, force: true });
      if (debugEnabled) {
        console.log(`Removed empty directory: ${dir}`);
      }
      // Try to remove parent directory too
      const parentDir = dirname(dir);
      await removeEmptyDirectory(parentDir, rootDir);
    }
  } catch {
    // Ignore errors (directory might have been removed already, or permission issues)
  }
}

async function cleanupSnapshotArtifacts(
  outputDir: string,
  storyId: string,
  snapshotRelativePath: string,
  mode: ArtifactCleanupMode,
): Promise<void> {
  try {
    // Get the directory and base filename from the snapshot path
    const snapshotDir = dirname(snapshotRelativePath);
    const snapshotFileName = snapshotRelativePath.split(/[/\\]/).pop() || `${storyId}.png`;
    const baseName = snapshotFileName.replace(/\.png$/i, '');
    const artifactDir = snapshotDir === '.' ? outputDir : join(outputDir, snapshotDir);

    // Check if directory exists
    if (!existsSync(artifactDir)) return;

    const files = await fsPromises.readdir(artifactDir);

    for (const file of files) {
      // Check if file is related to this story
      if (!file.startsWith(baseName) && file !== snapshotFileName.replace(/\.png$/i, '-error.png'))
        continue;

      // Match patterns for artifacts to clean up
      // Only clean up numbered retry attempts, NOT actual failure results
      const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const isNumberedAttempt = new RegExp(
        `^${escapedBaseName}-\\d+(-(actual|diff|expected))\\.png$`,
        'i',
      ).test(file);
      const isFailedScreenshot = /^test-failed-\d+\.png$/i.test(file);

      // Only remove retry artifacts, NOT actual failure results (diff.png, error.png, actual.png)
      // Failure results should only be deleted when test passes or story is removed
      const shouldRemove =
        mode === 'all'
          ? isNumberedAttempt || isFailedScreenshot
          : isNumberedAttempt || isFailedScreenshot;

      if (!shouldRemove) continue;

      const filePath = join(artifactDir, file);
      try {
        await fsPromises.unlink(filePath);
        if (debugEnabled) {
          const reason = mode === 'all' ? 'retry cleanup' : 'older attempt cleanup';
          console.log(`[${storyId}] Removed ${reason} artifact: ${join(snapshotDir, file)}`);
        }
        // Check if directory is now empty and remove it
        await removeEmptyDirectory(artifactDir, outputDir);
      } catch {
        // Ignore cleanup failures
      }
    }
  } catch (error) {
    if (debugEnabled) {
      console.log(
        `[${storyId}] Skipping snapshot artifact cleanup in ${outputDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// Log viewport configuration for debugging
if (debugEnabled) {
  console.log('SVR: Available viewport configurations:', Object.keys(discoveredViewportSizes));
  console.log('SVR: Default viewport:', effectiveDefaultViewport);
  console.log('SVR: Viewport sizes:', discoveredViewportSizes);
  console.log('SVR: Runtime options visual regression config:', runtimeOptions.visualRegression);
  console.log(
    'SVR: Runtime options viewportSizes:',
    runtimeOptions.visualRegression?.viewportSizes,
  );
  console.log(
    'SVR: Runtime options defaultViewport:',
    runtimeOptions.visualRegression?.defaultViewport,
  );
}

async function disableAnimations(page: Page): Promise<void> {
  // Respect reduced motion globally
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  } catch {
    /* noop */
  }

  // Disable CSS animations, transitions, and transforms globally using addInitScript
  // This runs before page content loads, ensuring animations are disabled from the start
  await page.addInitScript(() => {
    // Create style element to disable all animations
    const style = document.createElement('style');
    style.id = 'playwright-disable-all-animations';
    style.textContent = `
      *, *::before, *::after,
      [class*="animate"],
      [class*="spin"],
      [class*="fade"],
      [class*="slide"],
      [style*="animation"],
      [style*="transition"] {
        animation: none !important;
        transition: none !important;
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        animation-iteration-count: 0 !important;
        animation-name: none !important;
        animation-fill-mode: none !important;
        animation-play-state: paused !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        transition-property: none !important;
        scroll-behavior: auto !important;
        transform: none !important;
        will-change: auto !important;
      }
    `;

    // Insert at the beginning of head to ensure it has highest priority
    if (document.head.firstChild) {
      document.head.insertBefore(style, document.head.firstChild);
    } else {
      document.head.appendChild(style);
    }

    // Also pause all running animations immediately
    const pauseAllAnimations = () => {
      const allElements = document.querySelectorAll('*');
      allElements.forEach((el) => {
        const htmlEl = el as HTMLElement;
        try {
          if (htmlEl.style) {
            htmlEl.style.animationPlayState = 'paused';
            htmlEl.style.animation = 'none';
            htmlEl.style.transition = 'none';
          }
        } catch {
          // Ignore errors on special elements
        }
      });
    };

    // Run immediately
    pauseAllAnimations();

    // Also run after DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', pauseAllAnimations, { once: true });
    } else {
      pauseAllAnimations();
    }

    // Watch for new elements being added
    const observer = new MutationObserver(() => {
      pauseAllAnimations();
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  });

  // Note: actual pausing/resetting of SVG SMIL animations is done after the story loads
}

/**
 * Robustly set viewport size with validation and fallback handling
 */
async function setViewportSize(page: Page, viewportKey: string): Promise<void> {
  const viewportSizes = discoveredViewportSizes;
  const size = viewportSizes[viewportKey] || viewportSizes[effectiveDefaultViewport];

  if (!size || typeof size.width !== 'number' || typeof size.height !== 'number') {
    throw new Error(`Invalid viewport size for key '${viewportKey}': ${JSON.stringify(size)}`);
  }

  // Validate viewport dimensions
  if (size.width <= 0 || size.height <= 0) {
    throw new Error(`Viewport dimensions must be positive: ${size.width}x${size.height}`);
  }

  // Set viewport with retry logic
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      await page.setViewportSize(size);

      // Verify the viewport was actually set
      const actualSize = page.viewportSize();
      if (actualSize && actualSize.width === size.width && actualSize.height === size.height) {
        if (debugEnabled) {
          console.log(`SVR: Viewport set to ${size.width}x${size.height} (${viewportKey})`);
        }
        return;
      } else {
        if (debugEnabled) {
          console.log(
            `SVR: Viewport verification failed. Expected: ${size.width}x${size.height}, Actual: ${actualSize?.width}x${actualSize?.height}`,
          );
        }
        throw new Error(
          `Viewport verification failed. Expected: ${size.width}x${size.height}, Actual: ${actualSize?.width}x${actualSize?.height}`,
        );
      }
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        throw new Error(
          `Failed to set viewport after ${maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Wait a bit before retrying
      await page.waitForTimeout(100);
    }
  }
}

async function waitForStoryReady(page: Page): Promise<void> {
  const debugEnabled = runtimeOptions.debug;

  // Check if page is still valid before waiting
  if (page.isClosed()) {
    throw new Error('Page was closed before waiting for story ready');
  }

  // Make sure the canvas container exists
  // Use a short timeout since we already verified it exists after navigation
  // This is just a quick check to ensure it's still present
  try {
    await page.waitForSelector('#storybook-root', { state: 'attached', timeout: 2000 });
  } catch {
    // If it doesn't exist after 2s, that's unexpected but proceed anyway
    // The earlier check after navigation should have caught this
    if (debugEnabled) {
      console.warn('#storybook-root not found in waitForStoryReady, but proceeding');
    }
  }

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

  // Check if story is visually ready, but don't block if it doesn't stabilize
  // The mutationTimeout logic will handle DOM stability more accurately
  const isReady = await isVisuallyReady();
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
  // Note: finalSettle removed as it's not needed for Storybook visual regression testing

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
        ? `${entry.title ?? ''}${entry.title && entry.name ? ' / ' : ''}${entry.name ?? ''}`
        : id;
    storyDisplayNames[id] = human || id;

    // Convert display name to directory structure matching Storybook hierarchy
    // e.g., "Screens / Customer Display / Goodbye / With Cash Change" -> "Screens/Customer Display/Goodbye/With Cash Change.png"
    const displayName = storyDisplayNames[id];
    const parts = displayName
      .split(' / ')
      .map((part) => sanitizePathSegment(part))
      .filter(Boolean);

    if (parts.length > 0) {
      // Use all parts as directory structure, with the last part as the filename
      const fileName = parts[parts.length - 1] || id;
      const dirParts = parts.length > 1 ? parts.slice(0, -1) : [];
      const pathParts =
        dirParts.length > 0 ? [...dirParts, `${fileName}.png`] : [`${fileName}.png`];
      storySnapshotPaths[id] = join(...pathParts);
    } else {
      // Fallback to story ID if display name parsing fails
      storySnapshotPaths[id] = `${id}.png`;
    }
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

/**
 * Scan results directory for failed tests and return their story IDs
 */
function findFailedStoryIds(resultsDir: string, snapshotPaths: Record<string, string>): string[] {
  const failedStoryIds = new Set<string>();

  if (!existsSync(resultsDir)) {
    return [];
  }

  // Recursively scan results directory for failure indicators
  function scanDirectory(dir: string, baseDir: string = resultsDir): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          scanDirectory(fullPath, baseDir);
        } else if (entry.isFile()) {
          // Look for failure indicators: -diff.png, -error.png
          if (entry.name.endsWith('-diff.png') || entry.name.endsWith('-error.png')) {
            // Get the relative path from results directory
            const relativePath = relative(baseDir, fullPath);
            // Remove the suffix (-diff.png or -error.png) to get the snapshot path
            const snapshotPath = relativePath.replace(/-(diff|error)\.png$/i, '.png');

            // Find story ID by matching snapshot path
            for (const [storyId, snapshotPathForStory] of Object.entries(snapshotPaths)) {
              if (snapshotPathForStory === snapshotPath) {
                failedStoryIds.add(storyId);
                break;
              }
            }
          } else if (
            entry.name.endsWith('.png') &&
            !entry.name.includes('-diff') &&
            !entry.name.includes('-error')
          ) {
            // Check if this is an actual screenshot from a failed test
            // (it exists in results but snapshot might be missing or different)
            const relativePath = relative(baseDir, fullPath);

            // Check if there's a corresponding diff or if snapshot is missing
            const diffPath = fullPath.replace(/\.png$/i, '-diff.png');
            const errorPath = fullPath.replace(/\.png$/i, '-error.png');

            // If diff or error exists for this file, or if we can't find the story, include it
            if (existsSync(diffPath) || existsSync(errorPath)) {
              const snapshotPath = relativePath;

              // Find story ID by matching snapshot path
              for (const [storyId, snapshotPathForStory] of Object.entries(snapshotPaths)) {
                if (snapshotPathForStory === snapshotPath) {
                  failedStoryIds.add(storyId);
                  break;
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore errors when scanning
    }
  }

  scanDirectory(resultsDir);

  return Array.from(failedStoryIds);
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

  // Apply failed-only filter: only run tests that failed in the last run
  if (runtimeOptions.failedOnly) {
    const failedStoryIds = findFailedStoryIds(resultsDirectory, storySnapshotPaths);
    if (failedStoryIds.length === 0) {
      if (debugEnabled) {
        console.log(
          chalk.yellow('⚠️  No failed tests found in results directory. Running all tests.'),
        );
      } else {
        console.log(
          chalk.yellow('⚠️  No failed tests found in results directory. Nothing to rerun.'),
        );
      }
      // Return empty array to run nothing
      return [];
    }
    if (debugEnabled) {
      console.log(
        chalk.cyan(`🔄 Running only failed tests from last run: ${failedStoryIds.length} test(s)`),
      );
    } else {
      console.log(
        chalk.cyan(`🔄 Rerunning ${failedStoryIds.length} failed test(s) from previous run`),
      );
    }
    // Filter to only include failed story IDs
    const failedSet = new Set(failedStoryIds);
    return filtered.filter((storyId) => failedSet.has(storyId));
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
    test(humanTitle, async ({ page }) => {
      let viewportKey = effectiveDefaultViewport;
      const importPath = storyImportPaths[storyId];

      // Try to detect story-specific viewport from source code
      if (importPath) {
        try {
          const storySource = readFileSync(join(projectRoot, importPath), 'utf8');

          // Multiple regex patterns to catch different viewport configurations
          const viewportPatterns = [
            // Standard globals.viewport.value pattern
            /globals\s*:\s*\{[^}]*viewport\s*:\s*\{[^}]*value\s*:\s*['"](\w+)['"][^}]*\}[^}]*\}/,
            // Alternative viewport configuration patterns
            /viewport\s*:\s*['"](\w+)['"]/,
            /viewports\s*:\s*\{[^}]*default\s*:\s*['"](\w+)['"][^}]*\}/,
            // Parameters-based viewport
            /parameters\s*:\s*\{[^}]*viewport\s*:\s*\{[^}]*defaultViewport\s*:\s*['"](\w+)['"][^}]*\}[^}]*\}/,
          ];

          for (const pattern of viewportPatterns) {
            const match = storySource.match(pattern);
            if (debugEnabled) {
              console.log(`SVR: Pattern ${pattern} match result:`, match);
            }
            if (match && match[1] && discoveredViewportSizes[match[1]]) {
              viewportKey = match[1];
              if (debugEnabled) {
                console.log(`SVR: Detected viewport '${viewportKey}' for story ${storyId}`);
              }
              break;
            } else if (match && match[1]) {
              if (debugEnabled) {
                console.log(
                  `SVR: Found viewport '${match[1]}' but not in available viewports:`,
                  Object.keys(discoveredViewportSizes),
                );
              }
            }
          }
        } catch (error) {
          if (debugEnabled) {
            console.log(
              `SVR: Could not read story source for ${storyId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          // Keep default viewport
        }
      }

      // Set viewport with robust error handling
      try {
        await setViewportSize(page, viewportKey);
      } catch (error) {
        throw new Error(
          `Failed to set viewport for story ${storyId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await disableAnimations(page);

      // Pin the base time for deterministic snapshots while letting timers continue to tick
      // Install clock with timeout protection to prevent hanging
      try {
        await Promise.race([
          page.clock.install({
            time: new Date('2024-01-15T10:30:00.000Z'),
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Clock install timeout after 5s')), 5000),
          ),
        ]);
        try {
          await Promise.race([
            page.clock.resume(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Clock resume timeout after 2s')), 2000),
            ),
          ]);
        } catch (clockResumeError) {
          if (debugEnabled) {
            console.log(
              `SVR: Failed to resume Playwright clock: ${
                clockResumeError instanceof Error
                  ? clockResumeError.message
                  : String(clockResumeError)
              }`,
            );
          }
        }
      } catch (clockError) {
        if (debugEnabled) {
          console.log(
            `SVR: Failed to install Playwright clock (proceeding anyway): ${
              clockError instanceof Error ? clockError.message : String(clockError)
            }`,
          );
        }
        // Continue without clock - snapshots may be less deterministic but tests won't hang
      }

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

      // Track if we successfully took a screenshot (declared here for catch block access)
      let screenshotTaken = false;

      try {
        const waitTimeout = runtimeOptions.waitTimeout;
        const waitUntilOption = runtimeOptions.waitUntil;

        const operationStartTime = Date.now();
        if (debugEnabled) {
          console.log(`[${storyId}] Starting navigation at ${operationStartTime}`);
        }

        // Navigate to the story with a simple domcontentloaded wait
        let resp = await page.goto(storyUrl, {
          waitUntil: 'domcontentloaded',
        });

        if (debugEnabled) {
          console.log(`[${storyId}] Navigation completed in ${Date.now() - operationStartTime}ms`);
        }

        // First wait for storybook-root to exist before starting mutation observer
        // This ensures the page is actually loaded before we try to observe mutations
        try {
          await page.waitForSelector('#storybook-root', {
            state: 'attached',
            timeout: 5000, // Quick timeout - if it doesn't exist in 5s, something is wrong
          });
        } catch {
          // If storybook-root doesn't exist, continue anyway - mutation observer might still work
          if (debugEnabled) {
            console.warn(
              `[${storyId}] #storybook-root not found after navigation, proceeding anyway`,
            );
          }
        }

        // Wait for DOM to stabilize using MutationObserver
        // This is more accurate than waiting for resources - it waits for actual DOM changes to stop
        // Cap maximum wait time to prevent infinite hangs on continuously mutating stories
        const mutationTimeoutStart = Date.now();
        const mutationTimeoutMs = Math.min(runtimeOptions.mutationTimeout, 25); // Cap at 25ms for faster tests
        // Cap overall mutation wait to configured maximum (default 10s)
        // Don't use waitTimeout here - mutationMaxWait is independent and should be much shorter
        const maxMutationWait = runtimeOptions.mutationMaxWait || 10000;

        if (mutationTimeoutMs > 0) {
          if (debugEnabled) {
            console.log(
              `[${storyId}] Waiting for DOM to stabilize (${mutationTimeoutMs}ms after last mutation, max ${maxMutationWait}ms)`,
            );
          }

          try {
            await Promise.race([
              // Use waitForFunction but ensure it has proper timeout handling
              page
                .waitForFunction(
                  (args) => {
                    return new Promise<boolean>((resolve) => {
                      let timeoutId: ReturnType<typeof setTimeout> | null = null;
                      let resolved = false;
                      const { settleTime, maxWait } = args as {
                        settleTime: number;
                        maxWait: number;
                      };

                      // Declare observer variable first so it's available in maxTimeoutId handler
                      let observer: MutationObserver | null = null;

                      // Maximum timeout to prevent infinite hangs on continuously mutating stories
                      // Declare this FIRST so it's always available when mutations occur
                      const maxTimeoutId = setTimeout(
                        () => {
                          if (resolved) return;
                          resolved = true;
                          if (timeoutId !== null) clearTimeout(timeoutId);
                          if (observer) observer.disconnect();
                          resolve(true);
                        },
                        Math.max(1000, maxWait),
                      ); // Force resolve after configured max wait

                      observer = new MutationObserver(() => {
                        // Only reset if we haven't exceeded max wait
                        if (resolved) return;

                        // Clear existing timeout
                        if (timeoutId) {
                          clearTimeout(timeoutId);
                        }

                        // Set new timeout - DOM is stable when this timeout fires
                        timeoutId = setTimeout(() => {
                          if (resolved) return;
                          resolved = true;
                          if (observer) observer.disconnect();
                          clearTimeout(maxTimeoutId);
                          resolve(true);
                        }, settleTime as number);
                      });

                      // Start observing all DOM mutations
                      // Only observe if body exists and has content
                      const body = document.body;
                      if (observer && body) {
                        try {
                          observer.observe(body, {
                            childList: true,
                            subtree: true,
                            attributes: true,
                            characterData: true,
                            attributeOldValue: true,
                            characterDataOldValue: true,
                          });
                          // Initial timeout in case there are no mutations
                          timeoutId = setTimeout(() => {
                            if (resolved) return;
                            resolved = true;
                            if (observer) observer.disconnect();
                            clearTimeout(maxTimeoutId);
                            resolve(true);
                          }, settleTime as number);
                        } catch {
                          // If observe fails, resolve immediately
                          if (!resolved) {
                            resolved = true;
                            clearTimeout(maxTimeoutId);
                            resolve(true);
                          }
                        }
                      } else {
                        // No body element - resolve immediately
                        if (!resolved) {
                          resolved = true;
                          clearTimeout(maxTimeoutId);
                          resolve(true);
                        }
                      }
                    });
                  },
                  { settleTime: mutationTimeoutMs, maxWait: maxMutationWait },
                  // Set timeout to maxMutationWait + small buffer, but ensure it's not longer than test timeout
                  // This ensures waitForFunction times out before the test times out
                  {
                    timeout: Math.min(maxMutationWait + 500, 9000), // Cap at 9s to leave room for test timeout
                  },
                )
                .then(() => true) // Convert to boolean
                .catch(() => {
                  // If waitForFunction times out, that's okay - the race promise will handle it
                  return false;
                }),
              // Additional safety: force timeout after max wait
              new Promise<boolean>((resolve) =>
                setTimeout(() => {
                  if (debugEnabled) {
                    console.log(
                      `[${storyId}] Mutation wait force timeout after ${maxMutationWait}ms, proceeding`,
                    );
                  }
                  resolve(true);
                }, maxMutationWait),
              ),
            ]);

            if (debugEnabled) {
              console.log(`[${storyId}] DOM stabilized in ${Date.now() - mutationTimeoutStart}ms`);
            }
          } catch {
            if (debugEnabled) {
              console.log(
                `[${storyId}] DOM settle wait timed out after ${Date.now() - mutationTimeoutStart}ms, proceeding`,
              );
            }
          }
        }

        // Aggressively disable animations after page load and pause any running ones
        await page.evaluate(() => {
          // Remove any existing animation-disable style to avoid duplicates (except the init one)
          const existingStyle = document.getElementById('playwright-disable-animations');
          if (existingStyle && existingStyle.id !== 'playwright-disable-all-animations') {
            existingStyle.remove();
          }

          // Add/reinforce animation disabling with highest priority
          const style = document.createElement('style');
          style.id = 'playwright-disable-animations-post-load';
          style.textContent = `
            *, *::before, *::after,
            [class*="animate"],
            [class*="spin"],
            [class*="fade"],
            [class*="slide"],
            [style*="animation"],
            [style*="transition"] {
              animation: none !important;
              transition: none !important;
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              animation-iteration-count: 0 !important;
              animation-name: none !important;
              animation-fill-mode: none !important;
              animation-play-state: paused !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
              transition-property: none !important;
              scroll-behavior: auto !important;
              transform: none !important;
              will-change: auto !important;
            }
          `;

          // Insert at the beginning for highest priority
          if (document.head.firstChild) {
            document.head.insertBefore(style, document.head.firstChild);
          } else {
            document.head.appendChild(style);
          }

          // Force pause all running animations using JavaScript
          const pauseAllAnimations = () => {
            const allElements = document.querySelectorAll('*');
            allElements.forEach((el) => {
              const htmlEl = el as HTMLElement;
              try {
                if (htmlEl.style) {
                  htmlEl.style.animationPlayState = 'paused';
                  htmlEl.style.animation = 'none';
                  htmlEl.style.transition = 'none';
                  htmlEl.style.animationDuration = '0s';
                  htmlEl.style.transitionDuration = '0s';
                }

                // Get computed style and override if animated
                const computed = window.getComputedStyle(htmlEl);
                if (
                  computed.animationName !== 'none' ||
                  computed.animationPlayState === 'running'
                ) {
                  htmlEl.style.setProperty('animation-play-state', 'paused', 'important');
                  htmlEl.style.setProperty('animation', 'none', 'important');
                }
                if (computed.transitionProperty !== 'none') {
                  htmlEl.style.setProperty('transition', 'none', 'important');
                }
              } catch {
                // Ignore errors on special elements
              }
            });
          };

          // Run immediately and multiple times to catch late-loading elements
          pauseAllAnimations();
          setTimeout(pauseAllAnimations, 0);
          setTimeout(pauseAllAnimations, 50);
          setTimeout(pauseAllAnimations, 100);
        });

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

        // Wait for story to be ready with simple selector wait
        const storyWaitStart = Date.now();

        try {
          // Check if page is still valid before waiting
          if (page.isClosed()) {
            throw new Error('Page was closed before story wait');
          }

          // Simple wait for storybook root with short timeout
          await page.waitForSelector('#storybook-root', {
            state: 'attached',
            timeout: 2000, // Short timeout - if it's not ready in 2 seconds, proceed anyway
          });

          if (debugEnabled) {
            console.log(`[${storyId}] Story root found in ${Date.now() - storyWaitStart}ms`);
          }
        } catch (error) {
          if (debugEnabled) {
            console.log(
              `[${storyId}] Story root wait timed out after ${Date.now() - storyWaitStart}ms, proceeding`,
            );
            console.log(
              `[${storyId}] Story wait error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        // Skip additional waits - the story is already ready and stable
        if (debugEnabled) {
          console.log(`[${storyId}] Skipping additional waits - story is ready`);
        }

        // Fail fast on bad HTTP responses
        if (!resp || !resp.ok()) {
          // Try alternative path-based URL used by some Storybook setups
          const altUrl = candidateUrls[1];
          if (storyUrl !== altUrl) {
            storyUrl = altUrl;
            resp = await page.goto(storyUrl, { waitUntil: waitUntilOption });
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

        // Storybook-root was already checked after navigation, so skip redundant wait here
        // This was causing additional delays - we already confirmed it exists before mutation wait
        if (debugEnabled) {
          console.log(
            `[${storyId}] Skipping redundant #storybook-root wait (already checked after navigation)`,
          );
        }

        const beforeReadyWait = Date.now();
        if (debugEnabled) {
          console.log(`[${storyId}] Waiting for story to be ready...`);
        }
        await waitForStoryReady(page);
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

        // Get the snapshot path using directory structure from story display name
        const snapshotRelativePath = storySnapshotPaths[storyId] || `${storyId}.png`;

        // Construct the full snapshot path for validation
        const snapshotPath = join(snapshotsDirectory, snapshotRelativePath);
        if (debugEnabled) {
          console.log(`SVR: snapshot path resolved to ${snapshotPath}`);
        }

        console.log(
          `About to take screenshot for ${storyId}, update mode: ${runtimeOptions.updateSnapshots}`,
        );

        // Retry loop for taking screenshots
        let lastError: Error | null = null;
        if (runtimeOptions.snapshotRetries > 1 && debugEnabled) {
          console.log(
            `[${storyId}] Starting screenshot with ${runtimeOptions.snapshotRetries} retry attempts`,
          );
        }
        for (let attempt = 1; attempt <= runtimeOptions.snapshotRetries; attempt++) {
          try {
            // Apply snapshot delay before retry attempts (not the first attempt)
            if (runtimeOptions.snapshotDelay > 0 && attempt > 1) {
              if (debugEnabled) {
                console.log(
                  `[${storyId}] Attempt ${attempt}/${runtimeOptions.snapshotRetries}: Waiting ${runtimeOptions.snapshotDelay}ms before retry`,
                );
              }
              await page.waitForTimeout(runtimeOptions.snapshotDelay);
            }

            // For retry attempts, ensure the page is still ready
            if (attempt > 1) {
              if (debugEnabled) {
                console.log(`[${storyId}] Attempt ${attempt}: Re-checking page readiness...`);
              }

              // Verify page is still valid
              if (page.isClosed()) {
                throw new Error('Page was closed before retry screenshot');
              }

              // Re-check that the story root is still present and ready
              try {
                await page.waitForSelector('#storybook-root', {
                  state: 'attached',
                  timeout: 2000,
                });

                // Small settle time to ensure content is stable
                await page.waitForTimeout(100); // Reduced from 200ms to 100ms

                if (debugEnabled) {
                  console.log(`[${storyId}] Attempt ${attempt}: Page re-checked and ready`);
                }
              } catch (recheckError) {
                if (debugEnabled) {
                  console.log(
                    `[${storyId}] Attempt ${attempt}: Page re-check failed, proceeding anyway: ${recheckError instanceof Error ? recheckError.message : String(recheckError)}`,
                  );
                }
              }
            }

            // Verify page is still valid before attempting screenshot
            if (page.isClosed()) {
              throw new Error('Page was closed before screenshot could be taken');
            }

            // Take screenshot buffer
            const screenshotBuffer = await page.screenshot({
              fullPage: Boolean(runtimeOptions.fullPage),
            });

            // Ensure results directory exists (same structure as snapshots)
            const actualResultPath = join(resultsDirectory, snapshotRelativePath);
            await ensureDirectoryExists(dirname(actualResultPath));
            await fsPromises.writeFile(actualResultPath, screenshotBuffer);
            screenshotTaken = true; // Mark that we successfully took a screenshot

            // Ensure snapshot exists or create in update mode
            const snapshotExists = existsSync(snapshotPath);
            if (!snapshotExists) {
              if (runtimeOptions.updateSnapshots) {
                await ensureDirectoryExists(dirname(snapshotPath));
                await fsPromises.writeFile(snapshotPath, screenshotBuffer);
                // Clean up results since baseline now matches
                try {
                  await fsPromises.rm(actualResultPath, { force: true });
                  await removeEmptyDirectory(dirname(actualResultPath), resultsDirectory);
                } catch {
                  /* ignore */
                }
                break; // success for this attempt
              }
              throw new Error(
                `Missing baseline snapshot for '${storyId}'. Run update to create it: ${snapshotPath}`,
              );
            }

            // Skip odiff comparison in update mode - just update the snapshot
            if (runtimeOptions.updateSnapshots) {
              // Update mode: save screenshot as new baseline
              // Since the new baseline matches, this test now passes, so clean up failure results
              // Ensure snapshot directory exists before writing
              await ensureDirectoryExists(dirname(snapshotPath));
              await fsPromises.writeFile(snapshotPath, screenshotBuffer);
              try {
                await fsPromises.rm(actualResultPath, { force: true });
                await removeEmptyDirectory(dirname(actualResultPath), resultsDirectory);
              } catch {
                /* ignore */
              }
              // Also remove any error screenshots since test now passes with updated baseline
              try {
                const errorPath = actualResultPath.replace(/\.png$/i, '-error.png');
                await fsPromises.rm(errorPath, { force: true });
                await removeEmptyDirectory(dirname(errorPath), resultsDirectory);
              } catch {
                /* ignore */
              }
              if (debugEnabled) {
                console.log(
                  `[${storyId}] Updated snapshot and cleaned up previous failure results`,
                );
              }
              break;
            }

            // Use odiff to compare images and generate diff if they differ
            // odiff exit codes: 0 = match, 1 = differ, other = error
            const diffPath = actualResultPath.replace(/\.png$/i, '-diff.png');
            // Ensure directory exists before creating diff
            await ensureDirectoryExists(dirname(diffPath));

            // Verify both input files exist before calling odiff
            if (!existsSync(snapshotPath)) {
              throw new Error(`Baseline snapshot not found: ${snapshotPath}`);
            }
            if (!existsSync(actualResultPath)) {
              throw new Error(`Actual screenshot not found: ${actualResultPath}`);
            }

            let imagesMatch = false;
            try {
              // Use odiff Node.js bindings: compare(base, actual, diffOutput, options)
              // Returns: { match: boolean, reason?: 'layout-diff' | 'pixel-diff' | 'file-not-exists', ... }
              const odiffOptions: {
                threshold?: number;
                antialiasing?: boolean;
              } = {
                antialiasing: true, // Always enable antialiasing comparison
              };

              // Get threshold from config (0.0-1.0)
              if (runtimeOptions.visualRegression.threshold !== undefined) {
                odiffOptions.threshold = runtimeOptions.visualRegression.threshold;
              }

              const result = await compare(snapshotPath, actualResultPath, diffPath, odiffOptions);

              imagesMatch = result.match === true;

              if (imagesMatch) {
                // Images match - test PASSED, so delete any previous failure results
                // This is the only time we delete failed results (when test now passes)
                try {
                  await fsPromises.rm(actualResultPath, { force: true });
                  await fsPromises.rm(diffPath, { force: true });
                  // Also check for and remove error screenshots
                  const errorPath = actualResultPath.replace(/\.png$/i, '-error.png');
                  await fsPromises.rm(errorPath, { force: true });
                  await removeEmptyDirectory(dirname(actualResultPath), resultsDirectory);
                } catch {
                  /* ignore */
                }
                if (debugEnabled) {
                  console.log(
                    `[${storyId}] Images match - test passed, cleaned up previous failure results`,
                  );
                }
                break; // success (no diff)
              } else {
                // Images differ - check if diff file was created
                imagesMatch = false;
                // Wait a brief moment for file system to sync
                await new Promise((resolve) => setTimeout(resolve, 100));
                const diffExists = existsSync(diffPath);
                if (!diffExists) {
                  // odiff detected differences but didn't create diff file
                  console.error(
                    chalk.yellow(
                      `\n[${storyId}] ⚠️  odiff detected difference (reason: ${result.reason || 'unknown'}) but diff file was not created`,
                    ),
                  );
                  console.error(chalk.yellow(`  Diff path: ${diffPath}`));
                  console.error(chalk.yellow(`  Snapshot: ${snapshotPath}`));
                  console.error(chalk.yellow(`  Actual: ${actualResultPath}`));
                  if (result.reason === 'file-not-exists') {
                    console.error(chalk.yellow(`  Missing file: ${result.file || 'unknown'}`));
                  }
                  // Continue anyway - the actual screenshot is saved and can be compared manually
                } else if (debugEnabled) {
                  const reason = result.reason || 'unknown';
                  const diffInfo = result.diffPercentage
                    ? ` (${result.diffPercentage.toFixed(2)}% different)`
                    : '';
                  console.log(
                    `[${storyId}] Images differ (${reason}${diffInfo}), diff created: ${diffPath}`,
                  );
                }
              }
            } catch (odErr: unknown) {
              // Handle odiff errors (invalid images, permission errors, etc.)
              const errorMsg = odErr instanceof Error ? odErr.message : String(odErr);
              console.error(
                chalk.red(`[${storyId}] Failed to compare images with odiff: ${errorMsg}`),
              );
              // Rethrow to be caught by outer handler - this is a real error, not a visual difference
              throw new Error(
                `odiff failed to compare images: ${errorMsg}. Snapshot: ${snapshotPath}, Actual: ${actualResultPath}`,
              );
            }

            // If images match, we already broke out of the loop above
            // So if we reach here, images differ

            // Not update mode and images differ -> fail the test
            throw new Error(
              `Visual difference detected for '${storyId}'. See results: ${actualResultPath} and ${diffPath}`,
            );
          } catch (assertionError) {
            lastError =
              assertionError instanceof Error ? assertionError : new Error(String(assertionError));

            const errorMessage = lastError.message;
            const isBufferError =
              errorMessage.includes('The "data" argument must be of type string') ||
              errorMessage.includes('Received undefined');
            const isLastAttempt = attempt === runtimeOptions.snapshotRetries;

            if (!isLastAttempt) {
              if (isBufferError) {
                console.error(
                  chalk.red(
                    `[${storyId}] Screenshot failed due to page state error (attempt ${attempt}/${runtimeOptions.snapshotRetries}):`,
                  ),
                );
                console.error(chalk.red('  Page may be in an invalid state or closed'));
              } else {
                console.error(
                  chalk.yellow(
                    `[${storyId}] Screenshot failed on attempt ${attempt}/${runtimeOptions.snapshotRetries}, retrying...`,
                  ),
                );
                if (debugEnabled) {
                  console.error(chalk.dim(`  Error: ${errorMessage}`));
                }
              }

              await cleanupSnapshotArtifacts(
                resultsDirectory,
                storyId,
                snapshotRelativePath,
                'all',
              );

              if (!page.isClosed()) {
                await page.waitForTimeout(1000);
              }
              continue;
            }

            console.error(
              chalk.red(
                `[${storyId}] Screenshot failed after ${runtimeOptions.snapshotRetries} attempts`,
              ),
            );

            if (isBufferError) {
              await cleanupSnapshotArtifacts(
                resultsDirectory,
                storyId,
                snapshotRelativePath,
                'older',
              );
              throw new Error(
                `Failed to capture screenshot (page may have timed out or is in an invalid state): ${errorMessage}`,
              );
            }

            const isUpdateMode = runtimeOptions.updateSnapshots;
            console.log(`Screenshot failed for ${storyId}, isUpdateMode: ${isUpdateMode}`);

            if (isUpdateMode) {
              await cleanupSnapshotArtifacts(
                resultsDirectory,
                storyId,
                snapshotRelativePath,
                'older',
              );
              throw assertionError;
            }

            let snapshotExists = false;
            try {
              await fsPromises.access(snapshotPath);
              snapshotExists = true;
            } catch {
              snapshotExists = false;
            }

            if (!snapshotExists) {
              console.log(chalk.yellow(`\n📸 Creating missing snapshot: ${storyId}`));
              console.log(chalk.dim(`   URL: ${storyUrl}`));
              console.log(chalk.dim(`   Creating: ${snapshotPath}`));

              try {
                // Use buffer-based screenshot instead of toHaveScreenshot to avoid Playwright artifacts
                const screenshotBuffer = await page.screenshot({
                  fullPage: Boolean(runtimeOptions.fullPage),
                });
                await ensureDirectoryExists(dirname(snapshotPath));
                await fsPromises.writeFile(snapshotPath, screenshotBuffer);
                console.log(chalk.green(`✅ Successfully created snapshot for ${storyId}`));
                return;
              } catch (createError) {
                console.error(chalk.red(`❌ Failed to create snapshot for ${storyId}`));
                console.error(
                  chalk.dim(
                    `   Error: ${createError instanceof Error ? createError.message : String(createError)}`,
                  ),
                );
                await cleanupSnapshotArtifacts(
                  resultsDirectory,
                  storyId,
                  snapshotRelativePath,
                  'older',
                );
                throw createError;
              }
            } else {
              console.error(chalk.red(`\n❌ Screenshot Mismatch: ${storyId}`));
              console.error(chalk.dim(`   URL: ${storyUrl}`));
              console.error(chalk.dim(`   Reason: ${errorMessage}`));
              console.error(chalk.dim(`   Expected: ${snapshotPath}`));
              console.error(chalk.dim(`   Results: ${resultsDirectory}`));
              console.error(
                chalk.cyan(
                  `\n💡 Update snapshot: storybook-visual-regression update --include "${storyId}"`,
                ),
              );
            }

            await cleanupSnapshotArtifacts(
              resultsDirectory,
              storyId,
              snapshotRelativePath,
              'older',
            );

            throw assertionError;
          }
        }

        if (runtimeOptions.updateSnapshots) {
          try {
            await fsPromises.access(snapshotPath);
          } catch {
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

        // Create error screenshot ONLY for failed tests that didn't successfully take a screenshot
        // If we already have actualResultPath (x.png), we don't need x-error.png - they'd be duplicates
        try {
          if (!page.isClosed() && !screenshotTaken) {
            const snapshotRelativePath = storySnapshotPaths[storyId] || `${storyId}.png`;
            const actualResultPath = join(resultsDirectory, snapshotRelativePath);

            // Only create error screenshot if actualResultPath doesn't exist
            if (!existsSync(actualResultPath)) {
              const errorScreenshotPath = join(
                resultsDirectory,
                snapshotRelativePath.replace(/\.png$/i, '-error.png'),
              );
              await ensureDirectoryExists(dirname(errorScreenshotPath));
              // Use buffer-based screenshot to avoid Playwright artifact directories
              const errorScreenshotBuffer = await page.screenshot({
                fullPage: Boolean(runtimeOptions.fullPage),
              });
              await fsPromises.writeFile(errorScreenshotPath, errorScreenshotBuffer);
              console.log(`Error screenshot saved: ${errorScreenshotPath}`);
            }
          }
        } catch (screenshotError) {
          // If we can't take an error screenshot, that's okay - the main error is more important
          console.warn(
            `Could not create error screenshot: ${screenshotError instanceof Error ? screenshotError.message : String(screenshotError)}`,
          );
        }

        throw error;
      }
    });
  }
});
