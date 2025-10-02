import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { VisualRegressionConfig } from '../types/index.js';

export class StorybookConfigDetector {
  private cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /**
   * Detect Storybook configuration and merge with provided config
   */
  async detectAndMergeConfig(config: VisualRegressionConfig): Promise<VisualRegressionConfig> {
    const detectedConfig = await this.detectStorybookConfig();
    return this.mergeConfigs(config, detectedConfig);
  }

  /**
   * Detect Storybook configuration from various sources
   */
  private async detectStorybookConfig(): Promise<Partial<VisualRegressionConfig>> {
    const detected: Partial<VisualRegressionConfig> = {};

    // Detect Storybook port from package.json scripts
    const packageJsonPort = this.detectPortFromPackageJson();
    if (packageJsonPort) {
      detected.storybookPort = packageJsonPort;
      detected.storybookUrl = `http://localhost:${packageJsonPort}`;
    }

    // Detect Storybook command from package.json
    const storybookCommand = this.detectStorybookCommand();
    if (storybookCommand) {
      detected.storybookCommand = storybookCommand;
    }

    // Detect viewport configurations from Storybook config files
    const viewportConfig = this.detectViewportConfigurations();
    if (viewportConfig && Object.keys(viewportConfig).length > 0) {
      detected.viewportSizes = viewportConfig;
    }

    return detected;
  }

  /**
   * Detect Storybook port from package.json scripts
   */
  private detectPortFromPackageJson(): number | null {
    try {
      const packageJsonPath = join(this.cwd, 'package.json');
      if (!existsSync(packageJsonPath)) {
        return null;
      }

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const scripts = packageJson.scripts || {};

      // Look for common Storybook scripts
      const storybookScripts = [
        'storybook',
        'dev:storybook',
        'storybook:dev',
        'start:storybook',
        'storybook:start',
      ];

      for (const scriptName of storybookScripts) {
        const script = scripts[scriptName];
        if (typeof script === 'string') {
          // Extract port from script (e.g., "storybook dev -p 6006")
          const portMatch = script.match(/-p\s+(\d+)/);
          if (portMatch) {
            return parseInt(portMatch[1]);
          }
        }
      }

      return null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Detect Storybook command from package.json
   */
  private detectStorybookCommand(): string | null {
    try {
      const packageJsonPath = join(this.cwd, 'package.json');
      if (!existsSync(packageJsonPath)) {
        return null;
      }

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const scripts = packageJson.scripts || {};

      // Look for common Storybook scripts
      const storybookScripts = [
        'storybook',
        'dev:storybook',
        'storybook:dev',
        'start:storybook',
        'storybook:start',
      ];

      for (const scriptName of storybookScripts) {
        const script = scripts[scriptName];
        if (typeof script === 'string') {
          return `npm run ${scriptName}`;
        }
      }

      return null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Detect viewport configurations from Storybook config files
   */
  private detectViewportConfigurations(): Record<string, { width: number; height: number }> | null {
    const possibleConfigPaths = [
      join(this.cwd, '.storybook/main.js'),
      join(this.cwd, '.storybook/main.ts'),
      join(this.cwd, '.storybook/main.mjs'),
      join(this.cwd, 'storybook/main.js'),
      join(this.cwd, 'storybook/main.ts'),
      join(this.cwd, 'storybook/main.mjs'),
      join(this.cwd, '.storybook/preview.js'),
      join(this.cwd, '.storybook/preview.ts'),
      join(this.cwd, '.storybook/preview.mjs'),
      join(this.cwd, 'storybook/preview.js'),
      join(this.cwd, 'storybook/preview.ts'),
      join(this.cwd, 'storybook/preview.mjs'),
    ];

    for (const configPath of possibleConfigPaths) {
      if (existsSync(configPath)) {
        try {
          const configContent = readFileSync(configPath, 'utf8');
          const viewportConfig = this.parseViewportConfigFromFile(configContent);
          if (viewportConfig && Object.keys(viewportConfig).length > 0) {
            return viewportConfig;
          }
        } catch (_error) {
          // Continue to next file
        }
      }
    }

    return null;
  }

  /**
   * Parse viewport configurations from Storybook config file content
   */
  private parseViewportConfigFromFile(
    configContent: string,
  ): Record<string, { width: number; height: number }> | null {
    const config: Record<string, { width: number; height: number }> = {};

    // Look for viewport addon configurations
    const viewportMatch = configContent.match(/viewport.*?configurations.*?\{([^}]+)\}/s);
    if (viewportMatch) {
      const configSection = viewportMatch[1];

      // Look for viewport definitions like:
      // mobile: { name: 'Mobile', styles: { width: '375px', height: '667px' } }
      const viewportDefinitions = configSection.match(
        /(\w+):\s*\{[^}]*styles:\s*\{[^}]*width:\s*['"](\d+)px['"][^}]*height:\s*['"](\d+)px['"][^}]*\}/g,
      );

      if (viewportDefinitions) {
        for (const definition of viewportDefinitions) {
          const match = definition.match(
            /(\w+):\s*\{[^}]*width:\s*['"](\d+)px['"][^}]*height:\s*['"](\d+)px['"]/,
          );
          if (match) {
            const [, name, width, height] = match;
            config[name] = {
              width: parseInt(width),
              height: parseInt(height),
            };
          }
        }
      }
    }

    // Also look for viewport configurations in preview files
    const previewViewportMatch = configContent.match(/viewport.*?configurations.*?\{([^}]+)\}/s);
    if (previewViewportMatch) {
      const configSection = previewViewportMatch[1];
      const viewportDefinitions = configSection.match(
        /(\w+):\s*\{[^}]*styles:\s*\{[^}]*width:\s*['"](\d+)px['"][^}]*height:\s*['"](\d+)px['"][^}]*\}/g,
      );

      if (viewportDefinitions) {
        for (const definition of viewportDefinitions) {
          const match = definition.match(
            /(\w+):\s*\{[^}]*width:\s*['"](\d+)px['"][^}]*height:\s*['"](\d+)px['"]/,
          );
          if (match) {
            const [, name, width, height] = match;
            config[name] = {
              width: parseInt(width),
              height: parseInt(height),
            };
          }
        }
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  }

  /**
   * Merge detected configuration with provided configuration
   */
  private mergeConfigs(
    baseConfig: VisualRegressionConfig,
    detectedConfig: Partial<VisualRegressionConfig>,
  ): VisualRegressionConfig {
    return {
      ...baseConfig,
      ...detectedConfig,
      // Ensure viewportSizes is properly merged
      viewportSizes: {
        ...baseConfig.viewportSizes,
        ...(detectedConfig.viewportSizes || {}),
      },
    };
  }
}
