import type { VisualRegressionConfig } from '../types/index.js';

export function createDefaultConfig(): VisualRegressionConfig {
  return {
    // Storybook server configuration
    storybookUrl: 'http://localhost:9009',
    storybookPort: 9009,
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
    workers: 12,
    retries: 2,
    timeout: 30000,
    serverTimeout: 120000, // Increased to 2 minutes

    // Fail-fast
    maxFailures: 1,

    // Story filtering
    includeStories: [],
    excludeStories: [],

    // Advanced options
    disableAnimations: true,
    waitForNetworkIdle: true,
    contentStabilization: true,
  };
}
