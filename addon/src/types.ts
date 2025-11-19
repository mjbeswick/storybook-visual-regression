export type VisualRegressionConfig = {
  command?: string;
  port?: number;
  updateMode?: boolean;
  include?: string[];
  exclude?: string[];
  grep?: string;
};

export type TestResult = {
  storyId: string;
  storyName: string;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped';
  error?: string;
  diffPath?: string;
  actualPath?: string;
  expectedPath?: string;
  errorPath?: string;
  errorType?: 'screenshot_mismatch' | 'loading_failure' | 'network_error' | 'other_error';
  diffPixels?: number;
  diffPercent?: number;
};

export type FailedResult = {
  storyId: string;
  storyName: string;
  diffImagePath?: string;
  actualImagePath?: string;
  expectedImagePath?: string;
  errorImagePath?: string;
  errorType?: 'screenshot_mismatch' | 'loading_failure' | 'network_error' | 'other_error';
};

export type ProgressInfo = {
  completed: number;
  total: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  percent?: number;
  storiesPerMinute?: number;
  timeRemaining?: number;
  timeRemainingFormatted?: string;
  workers?: number;
  cpuUsage?: number;
  elapsed?: number;
};
