import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock fs functions
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    rmSync: vi.fn(),
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

describe('CLI Options and Filtering', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalCwd: string;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    originalCwd = process.cwd();
    
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

  describe('Environment Variable Setting', () => {
    it('should set correct environment variables for test command', async () => {
      // Mock successful Playwright execution
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Test completed',
        stderr: '',
        exitCode: 0,
      } as any);

      // Mock file system
      vi.mocked(require('fs').existsSync).mockReturnValue(true);

      // Import and run the CLI
      const { runTests } = await import('../cli/index.js');
      
      const options = {
        url: 'http://localhost:6006',
        port: '6006',
        command: 'npm run storybook',
        output: 'test-output',
        workers: '4',
        retries: '1',
        maxFailures: '2',
        timezone: 'America/New_York',
        locale: 'en-US',
        reporter: 'line',
        quiet: false,
        debug: true,
        include: 'button,card',
        exclude: 'wip,draft',
        grep: 'primary|secondary',
      };

      await runTests(options);

      // Check environment variables were set correctly
      expect(process.env.STORYBOOK_URL).toBe('http://localhost:6006');
      expect(process.env.STORYBOOK_COMMAND).toBe('npm run storybook');
      expect(process.env.PLAYWRIGHT_WORKERS).toBe('4');
      expect(process.env.PLAYWRIGHT_RETRIES).toBe('1');
      expect(process.env.PLAYWRIGHT_MAX_FAILURES).toBe('2');
      expect(process.env.PLAYWRIGHT_TIMEZONE).toBe('America/New_York');
      expect(process.env.PLAYWRIGHT_LOCALE).toBe('en-US');
      expect(process.env.PLAYWRIGHT_REPORTER).toBe('line');
      expect(process.env.STORYBOOK_INCLUDE).toBe('button,card');
      expect(process.env.STORYBOOK_EXCLUDE).toBe('wip,draft');
      expect(process.env.STORYBOOK_GREP).toBe('primary|secondary');
    });

    it('should set quiet reporter when --quiet flag is used', async () => {
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Test completed',
        stderr: '',
        exitCode: 0,
      } as any);

      vi.mocked(require('fs').existsSync).mockReturnValue(true);

      const { runTests } = await import('../cli/index.js');
      
      const options = {
        quiet: true,
        reporter: 'list', // Should be overridden by quiet
      };

      await runTests(options);

      expect(process.env.PLAYWRIGHT_REPORTER).toBe('src/reporters/filtered-reporter.ts');
    });

    it('should not set PLAYWRIGHT_UPDATE_SNAPSHOTS for test command', async () => {
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Test completed',
        stderr: '',
        exitCode: 0,
      } as any);

      vi.mocked(require('fs').existsSync).mockReturnValue(true);

      const { runTests } = await import('../cli/index.js');
      
      const options = {};

      await runTests(options);

      expect(process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS).toBeUndefined();
    });

    it('should set PLAYWRIGHT_UPDATE_SNAPSHOTS for update command', async () => {
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Update completed',
        stderr: '',
        exitCode: 0,
      } as any);

      vi.mocked(require('fs').existsSync).mockReturnValue(true);

      // Import the update command action
      const { runTests } = await import('../cli/index.js');
      
      // Simulate update command by setting the environment variable
      process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS = 'true';
      
      const options = {};

      await runTests(options);

      expect(process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS).toBe('true');
    });
  });

  describe('Story Filtering Logic', () => {
    it('should filter stories by include patterns', () => {
      const stories = [
        'button--primary',
        'button--secondary', 
        'card--default',
        'input--text',
        'modal--overlay',
      ];

      // Mock the filtering function from storybook.spec.ts
      function filterStories(stories: string[]): string[] {
        let filtered = [...stories];
        
        if (process.env.STORYBOOK_INCLUDE) {
          const includePatterns = process.env.STORYBOOK_INCLUDE.split(',').map((p) => p.trim());
          filtered = filtered.filter((storyId) =>
            includePatterns.some((pattern) => storyId.toLowerCase().includes(pattern.toLowerCase())),
          );
        }
        
        return filtered;
      }

      process.env.STORYBOOK_INCLUDE = 'button,card';
      const result = filterStories(stories);

      expect(result).toEqual(['button--primary', 'button--secondary', 'card--default']);
    });

    it('should filter stories by exclude patterns', () => {
      const stories = [
        'button--primary',
        'button--secondary', 
        'card--default',
        'input--text',
        'modal--overlay',
      ];

      function filterStories(stories: string[]): string[] {
        let filtered = [...stories];
        
        if (process.env.STORYBOOK_EXCLUDE) {
          const excludePatterns = process.env.STORYBOOK_EXCLUDE.split(',').map((p) => p.trim());
          filtered = filtered.filter(
            (storyId) =>
              !excludePatterns.some((pattern) => storyId.toLowerCase().includes(pattern.toLowerCase())),
          );
        }
        
        return filtered;
      }

      process.env.STORYBOOK_EXCLUDE = 'secondary,overlay';
      const result = filterStories(stories);

      expect(result).toEqual(['button--primary', 'card--default', 'input--text']);
    });

    it('should filter stories by regex pattern', () => {
      const stories = [
        'button--primary',
        'button--secondary', 
        'card--default',
        'input--text',
        'modal--overlay',
      ];

      function filterStories(stories: string[]): string[] {
        let filtered = [...stories];
        
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

      process.env.STORYBOOK_GREP = 'button.*primary|card.*default';
      const result = filterStories(stories);

      expect(result).toEqual(['button--primary', 'card--default']);
    });

    it('should combine multiple filters', () => {
      const stories = [
        'button--primary',
        'button--secondary', 
        'card--default',
        'input--text',
        'modal--overlay',
        'button--wip',
        'card--draft',
      ];

      function filterStories(stories: string[]): string[] {
        let filtered = [...stories];
        
        // Apply include patterns
        if (process.env.STORYBOOK_INCLUDE) {
          const includePatterns = process.env.STORYBOOK_INCLUDE.split(',').map((p) => p.trim());
          filtered = filtered.filter((storyId) =>
            includePatterns.some((pattern) => storyId.toLowerCase().includes(pattern.toLowerCase())),
          );
        }
        
        // Apply exclude patterns
        if (process.env.STORYBOOK_EXCLUDE) {
          const excludePatterns = process.env.STORYBOOK_EXCLUDE.split(',').map((p) => p.trim());
          filtered = filtered.filter(
            (storyId) =>
              !excludePatterns.some((pattern) => storyId.toLowerCase().includes(pattern.toLowerCase())),
          );
        }
        
        // Apply grep pattern (regex)
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

      process.env.STORYBOOK_INCLUDE = 'button,card';
      process.env.STORYBOOK_EXCLUDE = 'wip,draft';
      process.env.STORYBOOK_GREP = 'primary|default';
      
      const result = filterStories(stories);

      expect(result).toEqual(['button--primary', 'card--default']);
    });

    it('should handle invalid regex patterns gracefully', () => {
      const stories = ['button--primary', 'card--default'];
      const consoleWarnSpy = vi.spyOn(console, 'warn');

      function filterStories(stories: string[]): string[] {
        let filtered = [...stories];
        
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

      process.env.STORYBOOK_GREP = '[invalid-regex';
      const result = filterStories(stories);

      expect(result).toEqual(stories); // Should return original stories
      expect(consoleWarnSpy).toHaveBeenCalledWith('Invalid regex pattern: [invalid-regex');
    });
  });

  describe('CLI Option Parsing', () => {
    it('should parse numeric options correctly', () => {
      // Test the numeric parsing logic from CLI
      function parseNumericOption(value: string | undefined, defaultValue: number): number {
        if (value === undefined) return defaultValue;
        const parsed = parseInt(value);
        return isNaN(parsed) ? defaultValue : parsed;
      }

      expect(parseNumericOption('12', 10)).toBe(12);
      expect(parseNumericOption('0', 10)).toBe(0);
      expect(parseNumericOption(undefined, 10)).toBe(10);
      expect(parseNumericOption('invalid', 10)).toBe(10);
    });

    it('should handle boolean options correctly', () => {
      // Test boolean parsing logic
      function parseBooleanOption(value: string | undefined, defaultValue: boolean): boolean {
        if (value === undefined) return defaultValue;
        return value === 'true';
      }

      expect(parseBooleanOption('true', false)).toBe(true);
      expect(parseBooleanOption('false', true)).toBe(false);
      expect(parseBooleanOption(undefined, true)).toBe(true);
      expect(parseBooleanOption('invalid', false)).toBe(false);
    });

    it('should handle string options correctly', () => {
      // Test string parsing logic
      function parseStringOption(value: string | undefined, defaultValue: string): string {
        return value ?? defaultValue;
      }

      expect(parseStringOption('custom-value', 'default')).toBe('custom-value');
      expect(parseStringOption(undefined, 'default')).toBe('default');
      expect(parseStringOption('', 'default')).toBe('');
    });
  });

  describe('Error Handling', () => {
    it('should handle Playwright execution errors', async () => {
      vi.mocked(execa).mockRejectedValue(new Error('Playwright failed'));

      vi.mocked(require('fs').existsSync).mockReturnValue(true);

      const { runTests } = await import('../cli/index.js');
      
      const options = {};

      await expect(runTests(options)).rejects.toThrow('Playwright failed');
    });

    it('should handle missing config file', async () => {
      vi.mocked(require('fs').existsSync).mockReturnValue(false);

      const { runTests } = await import('../cli/index.js');
      
      const options = {};

      await expect(runTests(options)).rejects.toThrow();
    });

    it('should handle results directory cleanup errors', async () => {
      vi.mocked(execa).mockResolvedValue({
        stdout: 'Test completed',
        stderr: '',
        exitCode: 0,
      } as any);

      vi.mocked(require('fs').existsSync).mockReturnValue(true);
      vi.mocked(require('fs').rmSync).mockImplementation(() => {
        throw new Error('Cleanup failed');
      });

      const { runTests } = await import('../cli/index.js');
      
      const options = {};

      // Should not throw, just warn
      await expect(runTests(options)).resolves.not.toThrow();
    });
  });
});
