import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execa } from 'execa';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { StorybookConfigDetector } from '../core/StorybookConfigDetector.js';
import { StorybookDiscovery } from '../core/StorybookDiscovery.js';
import { VisualRegressionRunner } from '../core/VisualRegressionRunner.js';
import type { VisualRegressionConfig } from '../types/index.js';

// Mock execa for CLI testing
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock fs functions
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

// Mock playwright
vi.mock('playwright', async () => {
  const actual = await vi.importActual('playwright');
  return {
    ...actual,
    chromium: {
      launch: vi.fn(),
    },
  };
});

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    green: vi.fn((text) => text),
    red: vi.fn((text) => text),
    yellow: vi.fn((text) => text),
    blue: vi.fn((text) => text),
    cyan: vi.fn((text) => text),
    dim: vi.fn((text) => text),
  },
}));

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

describe('Integration Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    originalCwd = process.cwd();
    tempDir = '/tmp/storybook-visual-regression-test';
    
    // Reset all mocks
    vi.clearAllMocks();
    
    // Mock console methods to avoid noise in tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  describe('End-to-End CLI Workflow', () => {
    it('should complete full test workflow successfully', async () => {
      // Mock successful Playwright execution
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Running 5 tests using 4 workers\n✓ All tests passed',
        stderr: '',
        exitCode: 0,
      } as any);

      // Mock file system
      vi.mocked(existsSync).mockReturnValue(true);

      // Import and run the CLI
      const { runTests } = await import('../cli/index.js');
      
      const options = {
        url: 'http://localhost:6006',
        port: '6006',
        command: 'npm run storybook',
        workers: '4',
        quiet: true,
      };

      await runTests(options);

      // Verify Playwright was called with correct arguments
      expect(execa).toHaveBeenCalledWith('npx', [
        'playwright',
        'test',
        '--config',
        expect.stringContaining('svr.config.ts'),
      ], expect.any(Object));

      // Verify environment variables were set
      expect(process.env.STORYBOOK_URL).toBe('http://localhost:6006');
      expect(process.env.PLAYWRIGHT_WORKERS).toBe('4');
      expect(process.env.PLAYWRIGHT_REPORTER).toBe('src/reporters/filtered-reporter.ts');
    });

    it('should handle test failures gracefully', async () => {
      // Mock failed Playwright execution
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Running 5 tests using 4 workers\n✘ Some tests failed',
        stderr: '',
        exitCode: 1,
      } as any);

      vi.mocked(existsSync).mockReturnValue(true);

      const { runTests } = await import('../cli/index.js');
      
      const options = {};

      await runTests(options);

      // Should complete without throwing
      expect(execa).toHaveBeenCalled();
    });

    it('should handle Playwright execution errors', async () => {
      // Mock Playwright execution error
      vi.mocked(execa).mockRejectedValue(new Error('Playwright execution failed'));

      vi.mocked(existsSync).mockReturnValue(true);

      const { runTests } = await import('../cli/index.js');
      
      const options = {};

      await expect(runTests(options)).rejects.toThrow('Playwright execution failed');
    });
  });

  describe('Configuration Detection Integration', () => {
    it('should detect and merge Storybook configuration', async () => {
      const mockPackageJson = {
        scripts: {
          storybook: 'storybook dev -p 6006',
          'dev:storybook': 'storybook dev -p 9009',
        },
      };

      const mockStorybookConfig = `
        export default {
          addons: [
            {
              name: '@storybook/addon-viewport',
              options: {
                viewport: {
                  configurations: {
                    mobile: {
                      name: 'Mobile',
                      styles: { width: '375px', height: '667px' }
                    },
                    tablet: {
                      name: 'Tablet',
                      styles: { width: '768px', height: '1024px' }
                    }
                  }
                }
              }
            }
          ]
        };
      `;

      // Mock file system responses
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path.includes('package.json')) return true;
        if (path.includes('.storybook/main.ts')) return true;
        return false;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        if (path.includes('package.json')) {
          return JSON.stringify(mockPackageJson);
        }
        if (path.includes('.storybook/main.ts')) {
          return mockStorybookConfig;
        }
        return '';
      });

      const baseConfig: VisualRegressionConfig = {
        storybookUrl: 'http://localhost:9009',
        storybookPort: 9009,
        storybookCommand: 'npm run storybook',
        viewportSizes: { desktop: { width: 1920, height: 1080 } },
        headless: true,
        timezone: 'UTC',
        locale: 'en-US',
        serverTimeout: 120000,
      };

      const detector = new StorybookConfigDetector(tempDir);
      const result = await detector.detectAndMergeConfig(baseConfig);

      expect(result.storybookPort).toBe(6006); // Detected from package.json
      expect(result.storybookUrl).toBe('http://localhost:6006');
      expect(result.storybookCommand).toBe('npm run storybook');
      expect(result.viewportSizes).toEqual({
        desktop: { width: 1920, height: 1080 },
        mobile: { width: 375, height: 667 },
        tablet: { width: 768, height: 1024 },
      });
    });
  });

  describe('Story Discovery Integration', () => {
    it('should discover stories from dev server', async () => {
      const mockIndexData = {
        v: 4,
        entries: {
          'example-button--primary': {
            id: 'example-button--primary',
            title: 'Example/Button',
            name: 'Primary',
            importPath: './src/components/Button.stories.tsx',
            tags: ['story'],
            type: 'story',
          },
          'example-card--default': {
            id: 'example-card--default',
            title: 'Example/Card',
            name: 'Default',
            importPath: './src/components/Card.stories.tsx',
            tags: ['story'],
            type: 'story',
          },
        },
      };

      // Mock fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockIndexData),
      });

      const config: VisualRegressionConfig = {
        storybookUrl: 'http://localhost:6006',
        storybookPort: 6006,
        storybookCommand: 'npm run storybook',
        viewportSizes: { desktop: { width: 1920, height: 1080 } },
        headless: true,
        timezone: 'UTC',
        locale: 'en-US',
        serverTimeout: 120000,
      };

      const discovery = new StorybookDiscovery(config);
      const stories = await discovery.discoverStories();

      expect(stories).toHaveLength(2);
      expect(stories[0].id).toBe('example-button--primary');
      expect(stories[1].id).toBe('example-card--default');
      expect(fetch).toHaveBeenCalledWith('http://localhost:6006/index.json', {
        signal: expect.any(AbortSignal),
      });
    });

    it('should fallback to built files when dev server fails', async () => {
      const mockIndexData = {
        v: 4,
        entries: {
          'example-button--primary': {
            id: 'example-button--primary',
            title: 'Example/Button',
            name: 'Primary',
            importPath: './src/components/Button.stories.tsx',
            tags: ['story'],
            type: 'story',
          },
        },
      };

      // Mock fetch failure
      global.fetch = vi.fn().mockRejectedValue(new Error('Connection failed'));

      // Mock built files fallback
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockIndexData));

      const config: VisualRegressionConfig = {
        storybookUrl: 'http://localhost:6006',
        storybookPort: 6006,
        storybookCommand: 'npm run storybook',
        viewportSizes: { desktop: { width: 1920, height: 1080 } },
        headless: true,
        timezone: 'UTC',
        locale: 'en-US',
        serverTimeout: 120000,
      };

      const discovery = new StorybookDiscovery(config);
      const stories = await discovery.discoverStories();

      expect(stories).toHaveLength(1);
      expect(stories[0].id).toBe('example-button--primary');
      expect(readFileSync).toHaveBeenCalledWith(
        join(process.cwd(), 'storybook-static/index.json'),
        'utf8'
      );
    });
  });

  describe('Visual Regression Runner Integration', () => {
    it('should run visual regression tests end-to-end', async () => {
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue({
          newPage: vi.fn().mockResolvedValue({
            goto: vi.fn().mockResolvedValue(undefined),
            setViewportSize: vi.fn().mockResolvedValue(undefined),
            screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
            close: vi.fn().mockResolvedValue(undefined),
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as any);

      const config: VisualRegressionConfig = {
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

      const runner = new VisualRegressionRunner(config);
      await runner.initialize();

      // Mock story discovery
      const mockStories = [
        {
          id: 'example-button--primary',
          title: 'Example/Button',
          name: 'Primary',
          importPath: './src/components/Button.stories.tsx',
          tags: ['story'],
          type: 'story' as const,
        },
      ];

      // Mock StorybookDiscovery
      const { StorybookDiscovery } = await import('../core/StorybookDiscovery.js');
      const mockDiscovery = new StorybookDiscovery(config);
      vi.mocked(mockDiscovery.discoverStories).mockResolvedValue(mockStories);

      const results = await runner.runTests();

      expect(results.total).toBe(1);
      expect(results.passed).toBe(1);
      expect(results.failed).toBe(0);
      expect(results.results[0].storyId).toBe('example-button--primary');
      expect(results.results[0].success).toBe(true);

      await runner.cleanup();
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it('should handle test failures gracefully', async () => {
      const mockBrowser = {
        newContext: vi.fn().mockResolvedValue({
          newPage: vi.fn().mockResolvedValue({
            goto: vi.fn().mockRejectedValue(new Error('Navigation failed')),
            setViewportSize: vi.fn().mockResolvedValue(undefined),
            screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
            close: vi.fn().mockResolvedValue(undefined),
          }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const { chromium } = await import('playwright');
      vi.mocked(chromium.launch).mockResolvedValue(mockBrowser as any);

      const config: VisualRegressionConfig = {
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

      const runner = new VisualRegressionRunner(config);
      await runner.initialize();

      const mockStories = [
        {
          id: 'example-button--primary',
          title: 'Example/Button',
          name: 'Primary',
          importPath: './src/components/Button.stories.tsx',
          tags: ['story'],
          type: 'story' as const,
        },
      ];

      const { StorybookDiscovery } = await import('../core/StorybookDiscovery.js');
      const mockDiscovery = new StorybookDiscovery(config);
      vi.mocked(mockDiscovery.discoverStories).mockResolvedValue(mockStories);

      const results = await runner.runTests();

      expect(results.total).toBe(1);
      expect(results.passed).toBe(0);
      expect(results.failed).toBe(1);
      expect(results.results[0].success).toBe(false);
      expect(results.results[0].error).toContain('Navigation failed');

      await runner.cleanup();
    });
  });

  describe('Filtering Integration', () => {
    it('should filter stories correctly in end-to-end workflow', async () => {
      const mockStories = [
        'button--primary',
        'button--secondary',
        'card--default',
        'input--text',
        'modal--overlay',
      ];

      // Mock the filtering logic
      function filterStories(stories: string[]): string[] {
        let filtered = [...stories];
        
        if (process.env.STORYBOOK_INCLUDE) {
          const includePatterns = process.env.STORYBOOK_INCLUDE.split(',').map((p) => p.trim());
          filtered = filtered.filter((storyId) =>
            includePatterns.some((pattern) => storyId.toLowerCase().includes(pattern.toLowerCase())),
          );
        }
        
        if (process.env.STORYBOOK_EXCLUDE) {
          const excludePatterns = process.env.STORYBOOK_EXCLUDE.split(',').map((p) => p.trim());
          filtered = filtered.filter(
            (storyId) =>
              !excludePatterns.some((pattern) => storyId.toLowerCase().includes(pattern.toLowerCase())),
          );
        }
        
        if (process.env.STORYBOOK_GREP) {
          try {
            const regex = new RegExp(process.env.STORYBOOK_GREP, 'i');
            filtered = filtered.filter((storyId) => regex.test(storyId));
          } catch (error) {
            console.warn(`Invalid regex pattern: ${process.env.STORYBOOK_GREP}`);
          }
        }
        
        return filtered;
      }

      // Test include filter
      process.env.STORYBOOK_INCLUDE = 'button,card';
      let result = filterStories(mockStories);
      expect(result).toEqual(['button--primary', 'button--secondary', 'card--default']);

      // Test exclude filter
      process.env.STORYBOOK_EXCLUDE = 'secondary,overlay';
      result = filterStories(mockStories);
      expect(result).toEqual(['button--primary', 'card--default', 'input--text']);

      // Test grep filter
      process.env.STORYBOOK_GREP = 'primary|default';
      result = filterStories(mockStories);
      expect(result).toEqual(['button--primary', 'card--default']);

      // Test combined filters
      process.env.STORYBOOK_INCLUDE = 'button,card';
      process.env.STORYBOOK_EXCLUDE = 'secondary';
      process.env.STORYBOOK_GREP = 'primary|default';
      result = filterStories(mockStories);
      expect(result).toEqual(['button--primary', 'card--default']);
    });
  });

  describe('Error Handling Integration', () => {
    it('should handle configuration detection errors gracefully', async () => {
      // Mock file system errors
      vi.mocked(existsSync).mockReturnValue(false);

      const baseConfig: VisualRegressionConfig = {
        storybookUrl: 'http://localhost:6006',
        storybookPort: 6006,
        storybookCommand: 'npm run storybook',
        viewportSizes: { desktop: { width: 1920, height: 1080 } },
        headless: true,
        timezone: 'UTC',
        locale: 'en-US',
        serverTimeout: 120000,
      };

      const detector = new StorybookConfigDetector(tempDir);
      const result = await detector.detectAndMergeConfig(baseConfig);

      // Should return original config when detection fails
      expect(result).toEqual(baseConfig);
    });

    it('should handle story discovery errors gracefully', async () => {
      // Mock fetch failure
      global.fetch = vi.fn().mockRejectedValue(new Error('Connection failed'));

      // Mock built files failure
      vi.mocked(existsSync).mockReturnValue(false);

      const config: VisualRegressionConfig = {
        storybookUrl: 'http://localhost:6006',
        storybookPort: 6006,
        storybookCommand: 'npm run storybook',
        viewportSizes: { desktop: { width: 1920, height: 1080 } },
        headless: true,
        timezone: 'UTC',
        locale: 'en-US',
        serverTimeout: 120000,
      };

      const discovery = new StorybookDiscovery(config);

      await expect(discovery.discoverStories()).rejects.toThrow(
        'Unable to discover stories from Storybook'
      );
    });
  });
});
