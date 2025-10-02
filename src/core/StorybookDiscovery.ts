import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  StorybookIndex,
  StorybookEntry,
  VisualRegressionConfig,
  ViewportConfig,
} from '../types/index.js';

export class StorybookDiscovery {
  constructor(private config: VisualRegressionConfig) {}

  async discoverStories(): Promise<StorybookEntry[]> {
    try {
      console.log(`Connecting to Storybook at ${this.config.storybookUrl}`);

      // Get stories from dev server
      const response = await fetch(`${this.config.storybookUrl}/index.json`, {
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (response.ok) {
        const indexData: StorybookIndex = await response.json();
        console.log(`Successfully loaded stories from ${this.config.storybookUrl}`);
        return this.extractStoriesFromIndex(indexData);
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      // Fallback to built files
      try {
        console.log('Trying fallback to built Storybook files...');
        const indexFile = join(process.cwd(), 'storybook-static/index.json');
        const indexData: StorybookIndex = JSON.parse(readFileSync(indexFile, 'utf8'));
        console.log('Successfully loaded stories from built files');
        return this.extractStoriesFromIndex(indexData);
      } catch (fallbackError) {
        console.error('Error reading Storybook data:', error);
        console.log('\nTroubleshooting steps:');
        console.log('1. Make sure Storybook dev server is running:');
        console.log(`   ${this.config.storybookCommand || 'npm run dev:ui'}`);
        console.log('2. Check if Storybook is running on the correct port:');
        console.log(`   Expected: ${this.config.storybookUrl}`);
        console.log('3. Or build Storybook first:');
        console.log('   npm run build-storybook');
        console.log('4. Check your Storybook configuration for the correct port');
        throw new Error('Unable to discover stories from Storybook');
      }
    }
  }

  private extractStoriesFromIndex(indexData: StorybookIndex): StorybookEntry[] {
    const entries = indexData.entries || {};
    return Object.keys(entries)
      .filter((id) => entries[id].type === 'story')
      .map((id) => entries[id]);
  }

  async getStoryImportPath(storyId: string): Promise<string | undefined> {
    try {
      const response = await fetch(`${this.config.storybookUrl}/index.json`);
      if (response.ok) {
        const indexData: StorybookIndex = await response.json();
        const entry = indexData.entries[storyId];
        return entry?.importPath;
      }
    } catch (error) {
      // Fallback to built files
      try {
        const indexFile = join(process.cwd(), 'storybook-static/index.json');
        const indexData: StorybookIndex = JSON.parse(readFileSync(indexFile, 'utf8'));
        const entry = indexData.entries[storyId];
        return entry?.importPath;
      } catch (fallbackError) {
        // ignore read/parse errors
      }
    }
    return undefined;
  }

  async getViewportFromStorySource(storyId: string): Promise<string> {
    const importPath = await this.getStoryImportPath(storyId);
    if (!importPath) {
      return this.config.defaultViewport;
    }

    try {
      const storySource = readFileSync(
        join(process.cwd(), importPath.replace(/^\.\//, '')),
        'utf8',
      );

      // Look for viewport configuration in story parameters
      const viewportMatch = storySource.match(
        /globals\s*:\s*\{[^}]*viewport\s*:\s*\{[^}]*value\s*:\s*['"](\w+)['"][^}]*\}[^}]*\}/,
      );

      if (viewportMatch && viewportMatch[1] && this.config.viewportSizes[viewportMatch[1]]) {
        return viewportMatch[1];
      }
    } catch {
      // ignore read/parse errors and keep default
    }

    return this.config.defaultViewport;
  }

  async discoverViewportConfigurations(): Promise<ViewportConfig> {
    try {
      // Try to get viewport configurations from running Storybook
      const viewportConfig = await this.getViewportConfigFromStorybook();
      if (viewportConfig && Object.keys(viewportConfig).length > 0) {
        console.log('Successfully loaded viewport configurations from Storybook');
        return viewportConfig;
      }
    } catch (error) {
      console.log(
        'Could not load viewport configurations from Storybook:',
        error instanceof Error ? error.message : String(error),
      );
    }

    // Fallback to reading from Storybook configuration files
    try {
      const viewportConfig = this.getViewportConfigFromFiles();
      if (viewportConfig && Object.keys(viewportConfig).length > 0) {
        console.log('Successfully loaded viewport configurations from Storybook config files');
        return viewportConfig;
      }
    } catch (error) {
      console.log(
        'Could not load viewport configurations from config files:',
        error instanceof Error ? error.message : String(error),
      );
    }

    // Final fallback to default configurations
    console.log('Using default viewport configurations');
    return this.config.viewportSizes;
  }

  private async getViewportConfigFromStorybook(): Promise<ViewportConfig | null> {
    try {
      // Try to get globals from Storybook API
      const response = await fetch(`${this.config.storybookUrl}/api/globals`, {
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const globals = await response.json();

        // Look for viewport addon configuration in globals
        if (globals && globals.globals && globals.globals.viewport) {
          const viewportConfig = this.parseViewportConfigFromGlobals(globals.globals.viewport);
          if (viewportConfig) {
            return viewportConfig;
          }
        }
      }
    } catch (error) {
      // Ignore errors and try other methods
    }

    return null;
  }

  private getViewportConfigFromFiles(): ViewportConfig | null {
    const possibleConfigPaths = [
      join(process.cwd(), '.storybook/main.js'),
      join(process.cwd(), '.storybook/main.ts'),
      join(process.cwd(), '.storybook/main.mjs'),
      join(process.cwd(), 'storybook/main.js'),
      join(process.cwd(), 'storybook/main.ts'),
      join(process.cwd(), 'storybook/main.mjs'),
    ];

    for (const configPath of possibleConfigPaths) {
      if (existsSync(configPath)) {
        try {
          const configContent = readFileSync(configPath, 'utf8');
          const viewportConfig = this.parseViewportConfigFromFile(configContent);
          if (viewportConfig) {
            return viewportConfig;
          }
        } catch (error) {
          // Continue to next file
        }
      }
    }

    return null;
  }

  private parseViewportConfigFromGlobals(viewportGlobal: any): ViewportConfig | null {
    // This would parse viewport configurations from Storybook's globals
    // The exact structure depends on how the viewport addon stores its configuration
    if (viewportGlobal && typeof viewportGlobal === 'object') {
      const config: ViewportConfig = {};

      // Try to extract viewport configurations from the global
      if (viewportGlobal.configurations) {
        for (const [name, configData] of Object.entries(viewportGlobal.configurations)) {
          if (configData && typeof configData === 'object' && 'styles' in configData) {
            const styles = (configData as any).styles;
            if (styles && styles.width && styles.height) {
              config[name] = {
                width: parseInt(styles.width),
                height: parseInt(styles.height),
              };
            }
          }
        }
      }

      return Object.keys(config).length > 0 ? config : null;
    }

    return null;
  }

  private parseViewportConfigFromFile(configContent: string): ViewportConfig | null {
    // Parse viewport configurations from Storybook config files
    // Look for viewport addon configurations
    const viewportMatch = configContent.match(/viewport.*?configurations.*?\{([^}]+)\}/s);
    if (viewportMatch) {
      const config: ViewportConfig = {};

      // Try to parse viewport configurations from the config content
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

      return Object.keys(config).length > 0 ? config : null;
    }

    return null;
  }

  filterStories(stories: StorybookEntry[]): StorybookEntry[] {
    let filtered = stories;

    // Apply include filter
    if (this.config.includeStories && this.config.includeStories.length > 0) {
      filtered = filtered.filter((story) =>
        this.config.includeStories!.some(
          (pattern) => story.id.includes(pattern) || story.title.includes(pattern),
        ),
      );
    }

    // Apply exclude filter
    if (this.config.excludeStories && this.config.excludeStories.length > 0) {
      filtered = filtered.filter(
        (story) =>
          !this.config.excludeStories!.some(
            (pattern) => story.id.includes(pattern) || story.title.includes(pattern),
          ),
      );
    }

    return filtered;
  }
}
