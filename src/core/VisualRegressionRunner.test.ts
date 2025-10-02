import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VisualRegressionRunner } from './VisualRegressionRunner.js';
import { chromium, firefox, webkit } from 'playwright';
import type { VisualRegressionConfig, StorybookEntry } from '../types/index.js';

// Mock playwright
vi.mock('playwright', async () => {
  const actual = await vi.importActual('playwright');
  return {
    ...actual,
    chromium: {
      launch: vi.fn(),
    },
    firefox: {
      launch: vi.fn(),
    },
    webkit: {
      launch: vi.fn(),
    },
  };
});

// Mock StorybookDiscovery
vi.mock('../StorybookDiscovery.js', () => ({
  StorybookDiscovery: vi.fn().mockImplementation(() => ({
    discoverStories: vi.fn(),
    discoverViewportConfigurations: vi.fn(),
  })),
}));

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    green: vi.fn((text) => text),
    red: vi.fn((text) => text),
    yellow: vi.fn((text) => text),
    blue: vi.fn((text) => text),
    gray: vi.fn((text) => text),
  },
}));

describe('VisualRegressionRunner', () => {
  let runner: VisualRegressionRunner;
  let mockConfig: VisualRegressionConfig;
  let mockBrowser: any;
  let mockPage: any;
  let mockContext: any;

  beforeEach(() => {
    mockConfig = {
      storybookUrl: 'http://localhost:6006',
      storybookPort: 6006,
      storybookCommand: 'npm run storybook',
      viewportSizes: { desktop: { width: 1920, height: 1080 } },
      headless: true,
      timezone: 'UTC',
      locale: 'en-US',
      serverTimeout: 120000,
      discoverViewports: false,
    };

    runner = new VisualRegressionRunner(mockConfig);

    // Mock browser objects
    mockPage = {
      goto: vi.fn(),
      setViewportSize: vi.fn(),
      screenshot: vi.fn(),
      close: vi.fn(),
      evaluate: vi.fn(),
      waitForLoadState: vi.fn(),
      waitForSelector: vi.fn(),
    };

    mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn(),
    };

    mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };

    // Reset all mocks
    vi.clearAllMocks();
    
    // Mock console methods to avoid noise in tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(runner).toBeInstanceOf(VisualRegressionRunner);
    });
  });

  describe('initialize', () => {
    it('should initialize chromium browser by default', async () => {
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser);

      await runner.initialize();

      expect(chromium.launch).toHaveBeenCalledWith({
        headless: true,
      });
    });

    it('should initialize firefox browser when specified', async () => {
      const firefoxConfig = { ...mockConfig, browser: 'firefox' as const };
      const firefoxRunner = new VisualRegressionRunner(firefoxConfig);
      vi.mocked(firefox.launch).mockResolvedValue(mockBrowser);

      await firefoxRunner.initialize();

      expect(firefox.launch).toHaveBeenCalledWith({
        headless: true,
      });
    });

    it('should initialize webkit browser when specified', async () => {
      const webkitConfig = { ...mockConfig, browser: 'webkit' as const };
      const webkitRunner = new VisualRegressionRunner(webkitConfig);
      vi.mocked(webkit.launch).mockResolvedValue(mockBrowser);

      await webkitRunner.initialize();

      expect(webkit.launch).toHaveBeenCalledWith({
        headless: false,
      });
    });

    it('should handle browser launch errors', async () => {
      vi.mocked(chromium.launch).mockRejectedValue(new Error('Browser launch failed'));

      await expect(runner.initialize()).rejects.toThrow('Browser launch failed');
    });
  });

  describe('cleanup', () => {
    it('should close browser if initialized', async () => {
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser);
      await runner.initialize();

      await runner.cleanup();

      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should handle cleanup when browser not initialized', async () => {
      await expect(runner.cleanup()).resolves.not.toThrow();
    });
  });

  describe('runTests', () => {
    beforeEach(async () => {
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser);
      await runner.initialize();
    });

    it('should throw error if browser not initialized', async () => {
      const uninitializedRunner = new VisualRegressionRunner(mockConfig);

      await expect(uninitializedRunner.runTests()).rejects.toThrow(
        'Browser not initialized. Call initialize() first.'
      );
    });

    it('should run tests for discovered stories', async () => {
      const mockStories: StorybookEntry[] = [
        {
          id: 'example-button--primary',
          title: 'Example/Button',
          name: 'Primary',
          importPath: './src/components/Button.stories.tsx',
          tags: ['story'],
          type: 'story',
        },
        {
          id: 'example-card--default',
          title: 'Example/Card',
          name: 'Default',
          importPath: './src/components/Card.stories.tsx',
          tags: ['story'],
          type: 'story',
        },
      ];

      const { StorybookDiscovery } = await import('../StorybookDiscovery.js');
      const mockDiscovery = new StorybookDiscovery(mockConfig);
      vi.mocked(mockDiscovery.discoverStories).mockResolvedValue(mockStories);

      mockPage.goto.mockResolvedValue(undefined);
      mockPage.screenshot.mockResolvedValue(Buffer.from('fake-screenshot'));

      const results = await runner.runTests();

      expect(results.total).toBe(2);
      expect(results.passed).toBe(2);
      expect(results.failed).toBe(0);
      expect(mockPage.goto).toHaveBeenCalledTimes(2);
      expect(mockPage.screenshot).toHaveBeenCalledTimes(2);
    });

    it('should handle story discovery errors', async () => {
      const { StorybookDiscovery } = await import('../StorybookDiscovery.js');
      const mockDiscovery = new StorybookDiscovery(mockConfig);
      vi.mocked(mockDiscovery.discoverStories).mockRejectedValue(
        new Error('Discovery failed')
      );

      await expect(runner.runTests()).rejects.toThrow('Discovery failed');
    });

    it('should handle page navigation errors', async () => {
      const mockStories: StorybookEntry[] = [
        {
          id: 'example-button--primary',
          title: 'Example/Button',
          name: 'Primary',
          importPath: './src/components/Button.stories.tsx',
          tags: ['story'],
          type: 'story',
        },
      ];

      const { StorybookDiscovery } = await import('../StorybookDiscovery.js');
      const mockDiscovery = new StorybookDiscovery(mockConfig);
      vi.mocked(mockDiscovery.discoverStories).mockResolvedValue(mockStories);

      mockPage.goto.mockRejectedValue(new Error('Navigation failed'));

      const results = await runner.runTests();

      expect(results.total).toBe(1);
      expect(results.passed).toBe(0);
      expect(results.failed).toBe(1);
      expect(results.results[0].error).toContain('Navigation failed');
    });

    it('should handle screenshot errors', async () => {
      const mockStories: StorybookEntry[] = [
        {
          id: 'example-button--primary',
          title: 'Example/Button',
          name: 'Primary',
          importPath: './src/components/Button.stories.tsx',
          tags: ['story'],
          type: 'story',
        },
      ];

      const { StorybookDiscovery } = await import('../StorybookDiscovery.js');
      const mockDiscovery = new StorybookDiscovery(mockConfig);
      vi.mocked(mockDiscovery.discoverStories).mockResolvedValue(mockStories);

      mockPage.goto.mockResolvedValue(undefined);
      mockPage.screenshot.mockRejectedValue(new Error('Screenshot failed'));

      const results = await runner.runTests();

      expect(results.total).toBe(1);
      expect(results.passed).toBe(0);
      expect(results.failed).toBe(1);
      expect(results.results[0].error).toContain('Screenshot failed');
    });

    it('should discover viewport configurations when enabled', async () => {
      const viewportConfig = { ...mockConfig, discoverViewports: true };
      const viewportRunner = new VisualRegressionRunner(viewportConfig);
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser);
      await viewportRunner.initialize();

      const mockStories: StorybookEntry[] = [
        {
          id: 'example-button--primary',
          title: 'Example/Button',
          name: 'Primary',
          importPath: './src/components/Button.stories.tsx',
          tags: ['story'],
          type: 'story',
        },
      ];

      const { StorybookDiscovery } = await import('../StorybookDiscovery.js');
      const mockDiscovery = new StorybookDiscovery(viewportConfig);
      vi.mocked(mockDiscovery.discoverStories).mockResolvedValue(mockStories);
      vi.mocked(mockDiscovery.discoverViewportConfigurations).mockResolvedValue({
        mobile: { width: 375, height: 667 },
        tablet: { width: 768, height: 1024 },
      });

      mockPage.goto.mockResolvedValue(undefined);
      mockPage.screenshot.mockResolvedValue(Buffer.from('fake-screenshot'));

      const results = await viewportRunner.runTests();

      expect(mockDiscovery.discoverViewportConfigurations).toHaveBeenCalled();
      expect(results.total).toBe(2); // 1 story × 2 viewports
    });
  });

  describe('runTestForStory', () => {
    beforeEach(async () => {
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser);
      await runner.initialize();
    });

    it('should run test for single story', async () => {
      const story: StorybookEntry = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story',
      };

      mockPage.goto.mockResolvedValue(undefined);
      mockPage.screenshot.mockResolvedValue(Buffer.from('fake-screenshot'));

      const result = await runner['runTestForStory'](story);

      expect(result.storyId).toBe('example-button--primary');
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockPage.goto).toHaveBeenCalledWith(
        'http://localhost:6006/iframe.html?id=example-button--primary'
      );
    });

    it('should handle navigation errors', async () => {
      const story: StorybookEntry = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story',
      };

      mockPage.goto.mockRejectedValue(new Error('Navigation failed'));

      const result = await runner['runTestForStory'](story);

      expect(result.storyId).toBe('example-button--primary');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Navigation failed');
    });

    it('should handle screenshot errors', async () => {
      const story: StorybookEntry = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story',
      };

      mockPage.goto.mockResolvedValue(undefined);
      mockPage.screenshot.mockRejectedValue(new Error('Screenshot failed'));

      const result = await runner['runTestForStory'](story);

      expect(result.storyId).toBe('example-button--primary');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Screenshot failed');
    });

    it('should set viewport size before taking screenshot', async () => {
      const story: StorybookEntry = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story',
      };

      mockPage.goto.mockResolvedValue(undefined);
      mockPage.screenshot.mockResolvedValue(Buffer.from('fake-screenshot'));

      await runner['runTestForStory'](story);

      expect(mockPage.setViewportSize).toHaveBeenCalledWith({
        width: 1920,
        height: 1080,
      });
    });
  });

  describe('getBrowserType', () => {
    it('should return chromium by default', () => {
      const browserType = runner['getBrowserType']();
      expect(browserType).toBe(chromium);
    });

    it('should return firefox when specified', () => {
      const firefoxConfig = { ...mockConfig, browser: 'firefox' as const };
      const firefoxRunner = new VisualRegressionRunner(firefoxConfig);
      const browserType = firefoxRunner['getBrowserType']();
      expect(browserType).toBe(firefox);
    });

    it('should return webkit when specified', () => {
      const webkitConfig = { ...mockConfig, browser: 'webkit' as const };
      const webkitRunner = new VisualRegressionRunner(webkitConfig);
      const browserType = webkitRunner['getBrowserType']();
      expect(browserType).toBe(webkit);
    });
  });

  describe('getStoryUrl', () => {
    it('should generate correct story URL', () => {
      const story: StorybookEntry = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story',
      };

      const url = runner['getStoryUrl'](story);
      expect(url).toBe('http://localhost:6006/iframe.html?id=example-button--primary');
    });
  });

  describe('getScreenshotPath', () => {
    it('should generate correct screenshot path', () => {
      const story: StorybookEntry = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story',
      };

      const path = runner['getScreenshotPath'](story, 'desktop');
      expect(path).toBe('visual-regression/snapshots/example-button--primary-desktop.png');
    });

    it('should sanitize story ID in path', () => {
      const story: StorybookEntry = {
        id: 'example/button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story',
      };

      const path = runner['getScreenshotPath'](story, 'desktop');
      expect(path).toBe('visual-regression/snapshots/example-button--primary-desktop.png');
    });
  });
});
