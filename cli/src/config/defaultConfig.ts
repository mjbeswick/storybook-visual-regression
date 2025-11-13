/*
 * Default configuration for Storybook Visual Regression CLI
 */
export type ViewportSize = { name: string; width: number; height: number };

export type VisualRegressionConfig = {
  url: string;
  outputDir: string;
  snapshotPath: string;
  resultsPath: string;
  browser: 'chromium' | 'firefox' | 'webkit';
  workers?: number;
  retries: number;
  maxFailures?: number;
  threshold: number; // 0..1
  maxDiffPixels: number;
  fullPage: boolean;
  viewportSizes: ViewportSize[];
  defaultViewport: string;
  discoverViewports: boolean;
  mutationWait: number;
  mutationTimeout: number;
  domStabilityQuietPeriod?: number;
  domStabilityMaxWait?: number;
  storyLoadDelay?: number;
  snapshotRetries: number;
  snapshotDelay: number;
  includeStories?: string[];
  excludeStories?: string[];
  grep?: string;
  disableAnimations: boolean;
  fixDate?: boolean | string | number;
  frozenTime?: number;
  timezone?: string;
  locale?: string;
  masks?: Record<
    string,
    Array<{ selector?: string; x?: number; y?: number; width?: number; height?: number }>
  >;
  perStory?: Record<
    string,
    Partial<{
      threshold: number;
      viewport: string | { width: number; height: number };
      snapshotDelay: number;
      mutationWait: number;
      mutationTimeout: number;
      masks: Array<{ selector?: string; x?: number; y?: number; width?: number; height?: number }>;
    }>
  >;
  showProgress: boolean;
  summary: boolean;
};

export const defaultConfig = (): VisualRegressionConfig => {
  const outputDir = 'visual-regression';
  return {
    url: 'http://localhost:6006',
    outputDir,
    snapshotPath: `${outputDir}/snapshots`,
    resultsPath: `${outputDir}/results`,
    browser: 'chromium',
    workers: undefined,
    retries: 0,
    maxFailures: undefined,
    threshold: 0.2,
    maxDiffPixels: 0,
    fullPage: false,
    viewportSizes: [
      { name: 'mobile', width: 375, height: 667 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1024, height: 768 },
    ],
    defaultViewport: 'desktop',
    discoverViewports: true,
    mutationWait: 100,
    mutationTimeout: 0,
    domStabilityQuietPeriod: 200,
    domStabilityMaxWait: 2000,
    storyLoadDelay: 0,
    snapshotRetries: 1,
    snapshotDelay: 0,
    includeStories: undefined,
    excludeStories: undefined,
    grep: undefined,
    disableAnimations: true,
    fixDate: false,
    frozenTime: undefined,
    timezone: undefined,
    locale: undefined,
    masks: undefined,
    perStory: undefined,
    showProgress: true,
    summary: true,
  };
};

export type ResolvedPaths = {
  snapshotPath: string;
  resultsPath: string;
};
