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
  status: 'passed' | 'failed' | 'timedOut';
  error?: string;
  diffPath?: string;
  actualPath?: string;
  expectedPath?: string;
};
