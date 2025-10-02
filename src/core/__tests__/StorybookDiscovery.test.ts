import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StorybookDiscovery } from '../StorybookDiscovery.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { VisualRegressionConfig, StorybookIndex } from '../../types';

// Mock fs functions
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

// Mock fetch
global.fetch = vi.fn();

describe('StorybookDiscovery', () => {
  let discovery: StorybookDiscovery;
  let mockConfig: VisualRegressionConfig;

  beforeEach(() => {
    mockConfig = {
      storybookUrl: 'http://localhost:6006',
      storybookPort: 6006,
      storybookCommand: 'npm run storybook',
      viewportSizes: { desktop: { width: 1920, height: 1080 } },
      defaultViewport: 'desktop',
      threshold: 0.2,
      snapshotPath: './snapshots',
      resultsPath: './results',
      browser: 'chromium',
      headless: true,
      frozenTime: '2023-01-01T00:00:00.000Z',
      timezone: 'UTC',
      locale: 'en-US',
      workers: 1,
      retries: 0,
      timeout: 30000,
      serverTimeout: 120000,
      maxFailures: 0,
      disableAnimations: true,
      waitForNetworkIdle: true,
      contentStabilization: true,
    };

    discovery = new StorybookDiscovery(mockConfig);

    // Reset all mocks
    vi.clearAllMocks();

    // Mock console methods to avoid noise in tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('discoverStories', () => {
    it('should discover stories from dev server successfully', async () => {
      const mockIndexData: StorybookIndex = {
        entries: {
          'example-button--primary': {
            id: 'example-button--primary',
            title: 'Example/Button',
            name: 'Primary',
            importPath: './src/components/Button.stories.tsx',
            type: 'story',
          },
          'example-card--default': {
            id: 'example-card--default',
            title: 'Example/Card',
            name: 'Default',
            importPath: './src/components/Card.stories.tsx',
            type: 'story',
          },
        },
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockIndexData),
      } as Response);

      const result = await discovery.discoverStories();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('example-button--primary');
      expect(result[1].id).toBe('example-card--default');
      expect(fetch).toHaveBeenCalledWith('http://localhost:6006/index.json', {
        signal: expect.any(AbortSignal),
      });
    });

    it('should fallback to built files when dev server fails', async () => {
      const mockIndexData: StorybookIndex = {
        entries: {
          'example-button--primary': {
            id: 'example-button--primary',
            title: 'Example/Button',
            name: 'Primary',
            importPath: './src/components/Button.stories.tsx',
            type: 'story',
          },
        },
      };

      // Mock dev server failure
      vi.mocked(fetch).mockRejectedValue(new Error('Connection failed'));

      // Mock built files fallback
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockIndexData));

      const result = await discovery.discoverStories();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('example-button--primary');
      expect(readFileSync).toHaveBeenCalledWith(
        join(process.cwd(), 'storybook-static/index.json'),
        'utf8',
      );
    });

    it('should throw error when both dev server and built files fail', async () => {
      // Mock dev server failure
      vi.mocked(fetch).mockRejectedValue(new Error('Connection failed'));

      // Mock built files failure
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(discovery.discoverStories()).rejects.toThrow(
        'Unable to discover stories from Storybook',
      );
    });

    it('should handle HTTP error responses', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      // Mock built files fallback
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          v: 4,
          entries: {},
        }),
      );

      const result = await discovery.discoverStories();

      expect(result).toHaveLength(0);
    });

    it('should handle timeout errors', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Timeout'));

      // Mock built files fallback
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          v: 4,
          entries: {},
        }),
      );

      const result = await discovery.discoverStories();

      expect(result).toHaveLength(0);
    });
  });

  describe('extractStoriesFromIndex', () => {
    it('should extract stories from index data', () => {
      const mockIndexData: StorybookIndex = {
        entries: {
          'example-button--primary': {
            id: 'example-button--primary',
            title: 'Example/Button',
            name: 'Primary',
            importPath: './src/components/Button.stories.tsx',
            type: 'story',
          },
          'example-card--default': {
            id: 'example-card--default',
            title: 'Example/Card',
            name: 'Default',
            importPath: './src/components/Card.stories.tsx',
            type: 'story',
          },
          'example-docs--page': {
            id: 'example-docs--page',
            title: 'Example/Docs',
            name: 'Page',
            importPath: './src/components/Docs.mdx',
            type: 'docs',
          },
        },
      };

      const result = discovery['extractStoriesFromIndex'](mockIndexData);

      expect(result).toHaveLength(2); // Only stories, not docs
      expect(result[0].id).toBe('example-button--primary');
      expect(result[1].id).toBe('example-card--default');
    });

    it('should filter out non-story entries', () => {
      const mockIndexData: StorybookIndex = {
        entries: {
          'example-docs--page': {
            id: 'example-docs--page',
            title: 'Example/Docs',
            name: 'Page',
            importPath: './src/components/Docs.mdx',
            type: 'docs',
          },
          'example-csf--page': {
            id: 'example-csf--page',
            title: 'Example/CSF',
            name: 'Page',
            importPath: './src/components/CSF.stories.tsx',
            type: 'story',
          },
        },
      };

      const result = discovery['extractStoriesFromIndex'](mockIndexData);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('example-csf--page');
    });

    it('should handle empty entries', () => {
      const mockIndexData: StorybookIndex = {
        entries: {},
      };

      const result = discovery['extractStoriesFromIndex'](mockIndexData);

      expect(result).toHaveLength(0);
    });

    it('should handle malformed entries gracefully', () => {
      const mockIndexData: StorybookIndex = {
        entries: {
          'malformed-entry': {
            id: 'malformed-entry',
            // Missing required fields
          } as unknown,
        },
      };

      const result = discovery['extractStoriesFromIndex'](mockIndexData);

      expect(result).toHaveLength(0);
    });
  });

  describe('getViewportConfigForStory', () => {
    it('should return default viewport when no specific config', () => {
      const story = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story' as const,
      };

      const result = discovery['getViewportConfigForStory'](story);

      expect(result).toEqual({ desktop: { width: 1920, height: 1080 } });
    });

    it('should return specific viewport when configured', () => {
      const story = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story' as const,
      };

      // Mock viewport detection
      discovery['detectViewportFromStory'] = vi.fn().mockReturnValue({
        mobile: { width: 375, height: 667 },
      });

      const result = discovery['getViewportConfigForStory'](story);

      expect(result).toEqual({ mobile: { width: 375, height: 667 } });
    });
  });

  describe('detectViewportFromStory', () => {
    it('should detect viewport from story file', () => {
      const story = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story' as const,
      };

      const mockStoryContent = `
        export default {
          title: 'Example/Button',
          parameters: {
            viewport: {
              defaultViewport: 'mobile'
            }
          }
        };
      `;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockStoryContent);

      const result = discovery['detectViewportFromStory'](story);

      expect(result).toEqual({ mobile: { width: 375, height: 667 } });
    });

    it('should return null when story file does not exist', () => {
      const story = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story' as const,
      };

      vi.mocked(existsSync).mockReturnValue(false);

      const result = discovery['detectViewportFromStory'](story);

      expect(result).toBeNull();
    });

    it('should return null when no viewport configuration found', () => {
      const story = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story' as const,
      };

      const mockStoryContent = `
        export default {
          title: 'Example/Button'
        };
      `;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(mockStoryContent);

      const result = discovery['detectViewportFromStory'](story);

      expect(result).toBeNull();
    });

    it('should handle file read errors gracefully', () => {
      const story = {
        id: 'example-button--primary',
        title: 'Example/Button',
        name: 'Primary',
        importPath: './src/components/Button.stories.tsx',
        tags: ['story'],
        type: 'story' as const,
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('File read error');
      });

      const result = discovery['detectViewportFromStory'](story);

      expect(result).toBeNull();
    });
  });

  describe('parseViewportFromStoryFile', () => {
    it('should parse viewport configuration from story file', () => {
      const storyContent = `
        export default {
          title: 'Example/Button',
          parameters: {
            viewport: {
              defaultViewport: 'mobile'
            }
          }
        };
      `;

      const result = discovery['parseViewportFromStoryFile'](storyContent);

      expect(result).toEqual({ mobile: { width: 375, height: 667 } });
    });

    it('should parse multiple viewport configurations', () => {
      const storyContent = `
        export default {
          title: 'Example/Button',
          parameters: {
            viewport: {
              viewports: {
                mobile: { name: 'Mobile', styles: { width: '375px', height: '667px' } },
                tablet: { name: 'Tablet', styles: { width: '768px', height: '1024px' } }
              }
            }
          }
        };
      `;

      const result = discovery['parseViewportFromStoryFile'](storyContent);

      expect(result).toEqual({
        mobile: { width: 375, height: 667 },
        tablet: { width: 768, height: 1024 },
      });
    });

    it('should return null when no viewport configuration found', () => {
      const storyContent = `
        export default {
          title: 'Example/Button'
        };
      `;

      const result = discovery['parseViewportFromStoryFile'](storyContent);

      expect(result).toBeNull();
    });

    it('should handle malformed viewport configuration', () => {
      const storyContent = `
        export default {
          title: 'Example/Button',
          parameters: {
            viewport: {
              viewports: {
                mobile: { name: 'Mobile', styles: { width: 'invalid', height: '667px' } }
              }
            }
          }
        };
      `;

      const result = discovery['parseViewportFromStoryFile'](storyContent);

      expect(result).toBeNull();
    });
  });
});
