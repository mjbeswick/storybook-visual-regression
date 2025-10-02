import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StorybookDiscovery } from './StorybookDiscovery.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { VisualRegressionConfig, StorybookIndex, StorybookEntry } from '../types/index.js';

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
      headless: true,
      timezone: 'UTC',
      locale: 'en-US',
      serverTimeout: 120000,
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

      // Mock dev server failure
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

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
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

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

      expect(result).toEqual([]);
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

      expect(result).toEqual([]);
    });
  });

  describe('extractStoriesFromIndex', () => {
    it('should extract stories from index data', () => {
      const mockIndexData: StorybookIndex = {
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

      const result = discovery['extractStoriesFromIndex'](mockIndexData);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('example-button--primary');
      expect(result[1].id).toBe('example-card--default');
    });

    it('should filter out non-story entries', () => {
      const mockIndexData: StorybookIndex = {
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
          'example-button--docs': {
            id: 'example-button--docs',
            title: 'Example/Button',
            name: 'Docs',
            importPath: './src/components/Button.stories.tsx',
            tags: ['docs'],
            type: 'docs',
          },
        },
      };

      const result = discovery['extractStoriesFromIndex'](mockIndexData);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('example-button--primary');
    });

    it('should handle empty entries', () => {
      const mockIndexData: StorybookIndex = {
        v: 4,
        entries: {},
      };

      const result = discovery['extractStoriesFromIndex'](mockIndexData);

      expect(result).toEqual([]);
    });

    it('should handle malformed entries gracefully', () => {
      const mockIndexData: StorybookIndex = {
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
          'malformed-entry': {
            id: 'malformed-entry',
            title: 'Malformed',
            name: 'Entry',
            importPath: './src/components/Malformed.stories.tsx',
            tags: ['story'],
            type: 'docs', // Not a story type
          },
        },
      };

      const result = discovery['extractStoriesFromIndex'](mockIndexData);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('example-button--primary');
    });
  });

  describe('filterStories', () => {
    it('should filter stories by include patterns', () => {
      const stories: StorybookEntry[] = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
        { id: 'card--default', title: 'Card', name: 'Default' },
      ];

      const config = {
        ...mockConfig,
        includeStories: ['button', 'input'],
      };

      discovery = new StorybookDiscovery(config);
      const result = discovery.filterStories(stories);

      expect(result).toHaveLength(2);
      expect(result.map(s => s.id)).toEqual(['button--primary', 'input--text']);
    });

    it('should filter stories by exclude patterns', () => {
      const stories: StorybookEntry[] = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
        { id: 'card--default', title: 'Card', name: 'Default' },
      ];

      const config = {
        ...mockConfig,
        excludeStories: ['button'],
      };

      discovery = new StorybookDiscovery(config);
      const result = discovery.filterStories(stories);

      expect(result).toHaveLength(2);
      expect(result.map(s => s.id)).toEqual(['input--text', 'card--default']);
    });

    it('should combine include and exclude patterns', () => {
      const stories: StorybookEntry[] = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
        { id: 'card--default', title: 'Card', name: 'Default' },
      ];

      const config = {
        ...mockConfig,
        includeStories: ['button', 'input', 'card'],
        excludeStories: ['button'],
      };

      discovery = new StorybookDiscovery(config);
      const result = discovery.filterStories(stories);

      expect(result).toHaveLength(2);
      expect(result.map(s => s.id)).toEqual(['input--text', 'card--default']);
    });

    it('should return all stories when no filters are applied', () => {
      const stories: StorybookEntry[] = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
      ];

      discovery = new StorybookDiscovery(mockConfig);
      const result = discovery.filterStories(stories);

      expect(result).toEqual(stories);
    });
  });
});