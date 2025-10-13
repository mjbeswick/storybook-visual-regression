export type ViewportSize = {
  width: number;
  height: number;
};

export type ViewportConfig = {
  [key: string]: ViewportSize;
};

export type StorybookEntry = {
  id: string;
  title: string;
  name: string;
  importPath?: string;
  type: 'story' | 'docs';
};

export type StorybookIndex = {
  entries: Record<string, StorybookEntry>;
};

export type VisualRegressionConfig = {
  // Storybook server configuration
  storybookUrl: string;
  storybookPort: number;
  storybookCommand?: string;

  // Test configuration
  viewportSizes: ViewportConfig;
  defaultViewport: string;
  // Whether to dynamically discover viewport configurations from Storybook
  discoverViewports?: boolean;

  // Screenshot configuration
  threshold: number;
  snapshotPath: string;
  resultsPath: string;

  // Browser configuration
  browser: 'chromium' | 'firefox' | 'webkit';
  headless: boolean;

  // Timing configuration
  frozenTime: string;
  timezone: string;
  locale: string;

  // Test execution
  workers: number;
  retries: number;
  timeout: number;
  serverTimeout: number;
  // Fail-fast: stop after this many failures (<=0 disables)
  maxFailures: number;

  // Story filtering
  includeStories?: string[];
  excludeStories?: string[];

  // Advanced options
  disableAnimations: boolean;
  waitForNetworkIdle: boolean;
  contentStabilizationTime: number;

  // Loading spinner handling (always enabled)
  loadingSpinnerSelectors: string[];
  loadingSpinnerTimeout: number;
};

export type TestResult = {
  storyId: string;
  storyTitle: string;
  passed: boolean;
  error?: string;
  snapshotPath?: string;
  diffPath?: string;
  durationMs: number;
};

export type TestResults = {
  total: number;
  passed: number;
  failed: number;
  results: TestResult[];
};
