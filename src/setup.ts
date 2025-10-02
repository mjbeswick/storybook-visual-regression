import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// Global test setup
beforeAll(() => {
  // Set up global test environment
  process.env.NODE_ENV = 'test';

  // Mock global fetch if not available
  if (!global.fetch) {
    global.fetch = globalThis.fetch || (() => Promise.reject(new Error('fetch not available')));
  }

  // Mock AbortSignal.timeout if not available
  if (!AbortSignal.timeout) {
    AbortSignal.timeout = (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    };
  }
});

afterAll(() => {
  // Clean up global test environment
  delete process.env.NODE_ENV;
});

beforeEach(() => {
  // Reset mocks before each test
  vi.clearAllMocks();
});

afterEach(() => {
  // Clean up after each test
  vi.restoreAllMocks();
});

// Global test utilities
export const createMockConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  storybookUrl: 'http://localhost:6006',
  storybookPort: 6006,
  storybookCommand: 'npm run storybook',
  viewportSizes: { desktop: { width: 1920, height: 1080 } },
  headless: true,
  timezone: 'UTC',
  locale: 'en-US',
  serverTimeout: 120000,
  discoverViewports: false,
  ...overrides,
});

export const createMockStory = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'example-button--primary',
  title: 'Example/Button',
  name: 'Primary',
  importPath: './src/components/Button.stories.tsx',
  tags: ['story'],
  type: 'story' as const,
  ...overrides,
});

export const createMockStorybookIndex = (stories: unknown[] = []): Record<string, unknown> => ({
  entries: stories.reduce((acc: Record<string, unknown>, story: unknown) => {
    const storyObj = story as Record<string, unknown>;
    acc[storyObj.id as string] = story;
    return acc;
  }, {}),
});

export const mockFileSystem = (files: Record<string, string>): void => {
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedReadFileSync = vi.mocked(readFileSync);

  mockedExistsSync.mockImplementation((path: string) => {
    return Object.keys(files).some((filePath) => path.includes(filePath));
  });

  mockedReadFileSync.mockImplementation((path: string) => {
    const filePath = Object.keys(files).find((filePath) => path.includes(filePath));
    return filePath ? files[filePath] : '';
  });
};

export const mockFetch = (responses: Record<string, unknown>): void => {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    const response = responses[url];
    if (response) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(response),
      });
    }
    return Promise.reject(new Error(`No mock response for ${url}`));
  });
};

export const mockPlaywright = (): { mockBrowser: unknown; mockContext: unknown; mockPage: unknown } => {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
    close: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
  };

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  };

  return { mockBrowser, mockContext, mockPage };
};
