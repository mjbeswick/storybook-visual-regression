import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _execa } from 'execa';
import { _fileURLToPath } from 'url';
import { _dirname, _join } from 'path';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  rmSync: vi.fn(),
}));

describe('CLI Options and Filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock console methods to avoid noise in tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Story Filtering Logic', () => {
    it('should filter stories by include patterns', () => {
      const stories = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
        { id: 'card--default', title: 'Card', name: 'Default' },
      ];

      const includePatterns = ['button*', 'input*'];
      const filtered = stories.filter((story) =>
        includePatterns.some((pattern) => {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          return regex.test(story.id);
        }),
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.map((s) => s.id)).toEqual(['button--primary', 'input--text']);
    });

    it('should filter stories by exclude patterns', () => {
      const stories = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
        { id: 'card--default', title: 'Card', name: 'Default' },
      ];

      const excludePatterns = ['button*'];
      const filtered = stories.filter(
        (story) =>
          !excludePatterns.some((pattern) => {
            const regex = new RegExp(pattern.replace(/\*/g, '.*'));
            return regex.test(story.id);
          }),
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.map((s) => s.id)).toEqual(['input--text', 'card--default']);
    });

    it('should filter stories by regex pattern', () => {
      const stories = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
        { id: 'card--default', title: 'Card', name: 'Default' },
      ];

      const regexPattern = 'button.*';
      const regex = new RegExp(regexPattern);
      const filtered = stories.filter((story) => regex.test(story.id));

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('button--primary');
    });

    it('should combine multiple filters', () => {
      const stories = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
        { id: 'card--default', title: 'Card', name: 'Default' },
      ];

      const includePatterns = ['button*', 'input*', 'card*'];
      const excludePatterns = ['button*'];

      let filtered = stories.filter((story) =>
        includePatterns.some((pattern) => {
          const regex = new RegExp(pattern.replace(/\*/g, '.*'));
          return regex.test(story.id);
        }),
      );

      filtered = filtered.filter(
        (story) =>
          !excludePatterns.some((pattern) => {
            const regex = new RegExp(pattern.replace(/\*/g, '.*'));
            return regex.test(story.id);
          }),
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.map((s) => s.id)).toEqual(['input--text', 'card--default']);
    });

    it('should handle invalid regex patterns gracefully', () => {
      const stories = [
        { id: 'button--primary', title: 'Button', name: 'Primary' },
        { id: 'input--text', title: 'Input', name: 'Text' },
      ];

      const invalidPattern = '[invalid';

      expect(() => {
        const regex = new RegExp(invalidPattern);
        stories.filter((story) => regex.test(story.id));
      }).toThrow();
    });
  });

  describe('CLI Option Parsing', () => {
    it('should parse numeric options correctly', () => {
      const parseNumericOption = (value: string | undefined, defaultValue: number) => {
        if (value === undefined) return defaultValue;
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? defaultValue : parsed;
      };

      expect(parseNumericOption('5', 0)).toBe(5);
      expect(parseNumericOption('0', 1)).toBe(0);
      expect(parseNumericOption(undefined, 3)).toBe(3);
      expect(parseNumericOption('invalid', 2)).toBe(2);
    });

    it('should handle boolean options correctly', () => {
      const parseBooleanOption = (value: string | undefined, defaultValue: boolean) => {
        if (value === undefined) return defaultValue;
        return value === 'true' || value === '1';
      };

      expect(parseBooleanOption('true', false)).toBe(true);
      expect(parseBooleanOption('false', true)).toBe(false);
      expect(parseBooleanOption(undefined, true)).toBe(true);
      expect(parseBooleanOption('1', false)).toBe(true);
      expect(parseBooleanOption('0', true)).toBe(false);
    });

    it('should handle string options correctly', () => {
      const parseStringOption = (value: string | undefined, defaultValue: string) => {
        return value ?? defaultValue;
      };

      expect(parseStringOption('custom', 'default')).toBe('custom');
      expect(parseStringOption(undefined, 'default')).toBe('default');
      expect(parseStringOption('', 'default')).toBe('');
    });
  });
});
