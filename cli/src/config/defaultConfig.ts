import type { VisualRegressionConfig } from '../types/index.js';

export function createDefaultConfig(): VisualRegressionConfig {
  return {
    // Storybook server configuration
    storybookUrl: 'http://localhost:6006',
    storybookCommand: 'npm run storybook',

    // Test configuration
    viewportSizes: {
      mobile: { width: 375, height: 667 },
      tablet: { width: 768, height: 1024 },
      desktop: { width: 1024, height: 768 },
    },
    defaultViewport: 'desktop',
    discoverViewports: true,

    // Screenshot configuration
    threshold: 0.2,
    maxDiffPixels: 0, // Strict by default, can be overridden for CI
    snapshotPath: './visual-regression/snapshots',
    resultsPath: './visual-regression/results',

    // Browser configuration
    browser: 'chromium',
    headless: true,

    // Timing configuration
    frozenTime: '2024-01-15T10:30:00.000Z',
    timezone: 'Europe/London',
    locale: 'en-GB',

    // Test execution
    workers: 16, // Increased for powerful machines
    retries: 2,
    timeout: 30000,
    serverTimeout: 120000,

    // maxFailures: undefined means don't quit on any failures (run all tests)
    // Set to 0 to stop on first failure, or a number to stop after N failures
    // maxFailures: undefined, // Don't quit on any failures by default

    // Story filtering
    includeStories: [],
    excludeStories: [],

    // Advanced options
    disableAnimations: true,
    waitForNetworkIdle: true,
    contentStabilizationTime: 100,

    // Loading spinner handling (always enabled)
    loadingSpinnerSelectors: [
      '.sb-loader',
      '[data-testid="loading"]',
      '[data-testid="spinner"]',
      '[role="progressbar"]',
      '.loading-spinner',
      '.loading-indicator',
      '.loading:not(.loading-button):not(.loading-text)',
    ],
    loadingSpinnerTimeout: 10000,
  };
}
