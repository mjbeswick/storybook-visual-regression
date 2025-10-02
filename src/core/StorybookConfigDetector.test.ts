import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StorybookConfigDetector } from './StorybookConfigDetector.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { VisualRegressionConfig } from '../types/index.js';

// Mock fs functions
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

describe('StorybookConfigDetector', () => {
  let detector: StorybookConfigDetector;
  let mockCwd: string;
  let mockPackageJsonPath: string;
  let mockStorybookConfigPath: string;

  beforeEach(() => {
    mockCwd = '/test/project';
    mockPackageJsonPath = join(mockCwd, 'package.json');
    mockStorybookConfigPath = join(mockCwd, '.storybook/main.ts');
    detector = new StorybookConfigDetector(mockCwd);
    
    // Reset all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectAndMergeConfig', () => {
    it('should merge detected config with provided config', async () => {
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

      // Mock package.json with Storybook script
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === mockPackageJsonPath) return true;
        return false;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        if (path === mockPackageJsonPath) {
          return JSON.stringify({
            scripts: {
              storybook: 'storybook dev -p 9009',
            },
          });
        }
        return '';
      });

      const result = await detector.detectAndMergeConfig(baseConfig);

      expect(result.storybookPort).toBe(9009);
      expect(result.storybookUrl).toBe('http://localhost:9009');
      expect(result.storybookCommand).toBe('npm run storybook');
      expect(result.viewportSizes).toEqual({ desktop: { width: 1920, height: 1080 } });
    });

    it('should preserve base config when no detection occurs', async () => {
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

      // Mock no package.json exists
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await detector.detectAndMergeConfig(baseConfig);

      expect(result).toEqual(baseConfig);
    });
  });

  describe('detectPortFromPackageJson', () => {
    it('should detect port from storybook script', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        scripts: {
          storybook: 'storybook dev -p 6006',
        },
      }));

      const result = detector['detectPortFromPackageJson']();
      expect(result).toBe(6006);
    });

    it('should detect port from dev:storybook script', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        scripts: {
          'dev:storybook': 'storybook dev -p 9009',
        },
      }));

      const result = detector['detectPortFromPackageJson']();
      expect(result).toBe(9009);
    });

    it('should return null when no package.json exists', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = detector['detectPortFromPackageJson']();
      expect(result).toBeNull();
    });

    it('should return null when no storybook scripts found', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        scripts: {
          build: 'webpack',
          test: 'jest',
        },
      }));

      const result = detector['detectPortFromPackageJson']();
      expect(result).toBeNull();
    });

    it('should return null when storybook script has no port', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        scripts: {
          storybook: 'storybook dev',
        },
      }));

      const result = detector['detectPortFromPackageJson']();
      expect(result).toBeNull();
    });

    it('should handle malformed package.json gracefully', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('invalid json');

      const result = detector['detectPortFromPackageJson']();
      expect(result).toBeNull();
    });
  });

  describe('detectStorybookCommand', () => {
    it('should detect storybook command from package.json', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        scripts: {
          storybook: 'storybook dev -p 6006',
        },
      }));

      const result = detector['detectStorybookCommand']();
      expect(result).toBe('npm run storybook');
    });

    it('should detect dev:storybook command', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        scripts: {
          'dev:storybook': 'storybook dev',
        },
      }));

      const result = detector['detectStorybookCommand']();
      expect(result).toBe('npm run dev:storybook');
    });

    it('should return null when no package.json exists', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = detector['detectStorybookCommand']();
      expect(result).toBeNull();
    });

    it('should return null when no storybook scripts found', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        scripts: {
          build: 'webpack',
        },
      }));

      const result = detector['detectStorybookCommand']();
      expect(result).toBeNull();
    });
  });

  describe('detectViewportConfigurations', () => {
    it('should detect viewport configurations from main.ts', () => {
      const configContent = `
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

      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === mockStorybookConfigPath) return true;
        return false;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        if (path === mockStorybookConfigPath) return configContent;
        return '';
      });

      const result = detector['detectViewportConfigurations']();
      expect(result).toEqual({
        mobile: { width: 375, height: 667 },
        tablet: { width: 768, height: 1024 },
      });
    });

    it('should detect viewport configurations from preview.ts', () => {
      const previewPath = join(mockCwd, '.storybook/preview.ts');
      const configContent = `
        export const parameters = {
          viewport: {
            configurations: {
              desktop: {
                name: 'Desktop',
                styles: { width: '1920px', height: '1080px' }
              }
            }
          }
        };
      `;

      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === previewPath) return true;
        return false;
      });

      vi.mocked(readFileSync).mockImplementation((path) => {
        if (path === previewPath) return configContent;
        return '';
      });

      const result = detector['detectViewportConfigurations']();
      expect(result).toEqual({
        desktop: { width: 1920, height: 1080 },
      });
    });

    it('should return null when no config files exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = detector['detectViewportConfigurations']();
      expect(result).toBeNull();
    });

    it('should return null when config files have no viewport configurations', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('export default { addons: [] };');

      const result = detector['detectViewportConfigurations']();
      expect(result).toBeNull();
    });

    it('should handle malformed config files gracefully', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('File read error');
      });

      const result = detector['detectViewportConfigurations']();
      expect(result).toBeNull();
    });
  });

  describe('parseViewportConfigFromFile', () => {
    it('should parse viewport configurations from file content', () => {
      const configContent = `
        viewport: {
          configurations: {
            mobile: {
              name: 'Mobile',
              styles: { width: '375px', height: '667px' }
            },
            desktop: {
              name: 'Desktop',
              styles: { width: '1920px', height: '1080px' }
            }
          }
        }
      `;

      const result = detector['parseViewportConfigFromFile'](configContent);
      expect(result).toEqual({
        mobile: { width: 375, height: 667 },
        desktop: { width: 1920, height: 1080 },
      });
    });

    it('should return null when no viewport configurations found', () => {
      const configContent = 'export default { addons: [] };';

      const result = detector['parseViewportConfigFromFile'](configContent);
      expect(result).toBeNull();
    });

    it('should handle different quote styles', () => {
      const configContent = `
        viewport: {
          configurations: {
            mobile: {
              name: "Mobile",
              styles: { width: "375px", height: "667px" }
            }
          }
        }
      `;

      const result = detector['parseViewportConfigFromFile'](configContent);
      expect(result).toEqual({
        mobile: { width: 375, height: 667 },
      });
    });
  });

  describe('mergeConfigs', () => {
    it('should merge configurations correctly', () => {
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

      const detectedConfig = {
        storybookPort: 9009,
        storybookUrl: 'http://localhost:9009',
        viewportSizes: { mobile: { width: 375, height: 667 } },
      };

      const result = detector['mergeConfigs'](baseConfig, detectedConfig);

      expect(result.storybookPort).toBe(9009);
      expect(result.storybookUrl).toBe('http://localhost:9009');
      expect(result.storybookCommand).toBe('npm run storybook');
      expect(result.viewportSizes).toEqual({
        desktop: { width: 1920, height: 1080 },
        mobile: { width: 375, height: 667 },
      });
    });

    it('should preserve base config when detected config is empty', () => {
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

      const result = detector['mergeConfigs'](baseConfig, {});

      expect(result).toEqual(baseConfig);
    });
  });
});
