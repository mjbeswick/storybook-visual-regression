import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import picomatch from 'picomatch';
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
    } catch (_error) {
      // Fallback to built files
      try {
        console.log('Trying fallback to built Storybook files...');
        const indexFile = join(process.cwd(), 'storybook-static/index.json');
        const indexData: StorybookIndex = JSON.parse(readFileSync(indexFile, 'utf8'));
        console.log('Successfully loaded stories from built files');
        return this.extractStoriesFromIndex(indexData);
      } catch (fallbackError) {
        console.error('Error reading Storybook data:', fallbackError);
        console.log('\nTroubleshooting steps:');
        console.log('1. Make sure Storybook dev server is running:');
        console.log(`   ${this.config.storybookCommand || 'npm run storybook'}`);
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
      .map((id) => entries[id])
      .filter(
        (entry) =>
          entry &&
          entry.type === 'story' &&
          typeof entry.id === 'string' &&
          entry.id.length > 0 &&
          typeof entry.title === 'string' &&
          entry.title.length > 0 &&
          typeof entry.name === 'string' &&
          entry.name.length > 0 &&
          typeof entry.importPath === 'string' &&
          entry.importPath.length > 0,
      );
  }

  async getStoryImportPath(storyId: string): Promise<string | undefined> {
    try {
      const response = await fetch(`${this.config.storybookUrl}/index.json`);
      if (response.ok) {
        const indexData: StorybookIndex = await response.json();
        const entry = indexData.entries[storyId];
        return entry?.importPath;
      }
    } catch (_error) {
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

  async discoverViewportConfigurations(): Promise<{
    viewportSizes: ViewportConfig;
    defaultViewport?: string;
  }> {
    try {
      // Try to get viewport configurations from running Storybook
      const viewportConfig = await this.getViewportConfigFromStorybook();
      if (viewportConfig && Object.keys(viewportConfig).length > 0) {
        const validatedConfig = this.validateViewportConfig(viewportConfig);
        if (validatedConfig) {
          console.log('Successfully loaded viewport configurations from Storybook');
          return { viewportSizes: validatedConfig };
        }
      }
    } catch (_error) {
      console.log(
        'Could not load viewport configurations from Storybook:',
        _error instanceof Error ? _error.message : String(_error),
      );
    }

    // Fallback to reading from Storybook configuration files
    try {
      const viewportConfig = this.getViewportConfigFromFiles();
      if (viewportConfig && Object.keys(viewportConfig).length > 0) {
        const validatedConfig = this.validateViewportConfig(viewportConfig);
        if (validatedConfig) {
          console.log('Successfully loaded viewport configurations from Storybook config files');
          // Extract default viewport if it was stored in the config
          const defaultViewport = (viewportConfig as any).__defaultViewport;
          return { viewportSizes: validatedConfig, defaultViewport };
        }
      }
    } catch (_error) {
      console.log(
        'Could not load viewport configurations from config files:',
        _error instanceof Error ? _error.message : String(_error),
      );
    }

    // Final fallback to default configurations
    console.log('Using default viewport configurations');
    return { viewportSizes: this.config.viewportSizes };
  }

  /**
   * Validate viewport configuration to ensure all sizes are valid
   */
  private validateViewportConfig(config: ViewportConfig): ViewportConfig | null {
    const validated: ViewportConfig = {};
    let hasValidConfigs = false;

    for (const [key, size] of Object.entries(config)) {
      if (size && typeof size.width === 'number' && typeof size.height === 'number') {
        if (size.width > 0 && size.height > 0) {
          validated[key] = size;
          hasValidConfigs = true;
        } else {
          console.warn(
            `Skipping invalid viewport '${key}': dimensions must be positive (${size.width}x${size.height})`,
          );
        }
      } else {
        console.warn(`Skipping invalid viewport '${key}': missing or invalid dimensions`);
      }
    }

    return hasValidConfigs ? validated : null;
  }

  // Returns specific viewport config for a story if found, otherwise the defaults
  private getViewportConfigForStory(story: StorybookEntry): ViewportConfig {
    const detected = this.detectViewportFromStory(story);
    return detected ?? this.config.viewportSizes;
  }

  // Attempts to detect viewport configuration by reading the story source file
  private detectViewportFromStory(story: StorybookEntry): ViewportConfig | null {
    try {
      if (!story.importPath) return null;
      const absolutePath = join(process.cwd(), story.importPath.replace(/^\.\//, ''));
      if (!existsSync(absolutePath)) return null;
      const content = readFileSync(absolutePath, 'utf8');
      return this.parseViewportFromStoryFile(content);
    } catch (_error) {
      return null;
    }
  }

  // Parses viewport configuration from story file content
  private parseViewportFromStoryFile(content: string): ViewportConfig | null {
    // 1) Handle defaultViewport names commonly used by Storybook viewport addon
    const defaultViewportMatch = content.match(
      /parameters\s*:\s*\{[\s\S]*?viewport\s*:\s*\{[\s\S]*?defaultViewport\s*:\s*['"](\w+)['"][\s\S]*?\}/,
    );

    const defaultNameToSize: Record<string, { width: number; height: number }> = {
      mobile: { width: 375, height: 667 },
      tablet: { width: 768, height: 1024 },
      desktop: { width: 1920, height: 1080 },
      largeDesktop: { width: 2560, height: 1440 },
    };

    if (defaultViewportMatch) {
      const name = defaultViewportMatch[1];
      const preset = defaultNameToSize[name];
      if (preset) {
        return { [name]: { width: preset.width, height: preset.height } } as ViewportConfig;
      }
    }

    // 2) Parse explicit viewports with pixel sizes
    const config: ViewportConfig = {};

    // Extract the balanced block for viewports to avoid false positives
    const findViewportsBlock = (): string | null => {
      const vpIndex = content.search(/viewports\s*:/);
      if (vpIndex === -1) return null;
      const braceStart = content.indexOf('{', vpIndex);
      if (braceStart === -1) return null;
      let depth = 0;
      for (let i = braceStart; i < content.length; i++) {
        const ch = content[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            return content.slice(braceStart + 1, i); // inner content without outer braces
          }
        }
      }
      return null;
    };

    const textToScan = findViewportsBlock() ?? content;

    const definitionRegex =
      /(\w+)\s*:\s*\{[\s\S]*?styles\s*:\s*\{[\s\S]*?width\s*:\s*['"](\d+)px['"][\s\S]*?height\s*:\s*['"](\d+)px['"][\s\S]*?\}\s*\}/g;
    let match: RegExpExecArray | null;
    while ((match = definitionRegex.exec(textToScan)) !== null) {
      const name = match[1];
      const width = parseInt(match[2], 10);
      const height = parseInt(match[3], 10);
      if (!Number.isNaN(width) && !Number.isNaN(height)) {
        config[name] = { width, height };
      }
    }

    if (Object.keys(config).length > 0) {
      return config;
    }

    return null;
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
    } catch (_error) {
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
      // Also check preview files where viewport configurations are often defined
      join(process.cwd(), '.storybook/preview.js'),
      join(process.cwd(), '.storybook/preview.ts'),
      join(process.cwd(), '.storybook/preview.tsx'),
      join(process.cwd(), '.storybook/preview.mjs'),
      join(process.cwd(), 'storybook/preview.js'),
      join(process.cwd(), 'storybook/preview.ts'),
      join(process.cwd(), 'storybook/preview.tsx'),
      join(process.cwd(), 'storybook/preview.mjs'),
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
    // Look for viewport addon configurations in different formats

    // First, look for initialGlobals.viewport.value to determine the default viewport
    const defaultViewportMatch = configContent.match(
      /initialGlobals:\s*\{[\s\S]*?viewport:\s*\{\s*value:\s*['"](\w+)['"][\s\S]*?\}/,
    );
    const defaultViewport = defaultViewportMatch ? defaultViewportMatch[1] : null;

    // Format 1: viewport: { options: { ... } }
    // Look for the viewport options section specifically
    // Make sure we're matching viewport that directly contains options, not value
    // Look for the specific pattern: viewport: { options: { ... } }
    // Use greedy match to capture all viewport configurations
    const optionsMatch = configContent.match(/viewport:\s*\{\s*options:\s*\{([\s\S]+)\s*\},?\s*\}/);
    const viewportOptionsMatch = optionsMatch ? [optionsMatch[0], optionsMatch[1]] : null;
    if (viewportOptionsMatch) {
      const config: ViewportConfig = {};
      const optionsSection = viewportOptionsMatch[1];

      // Look for viewport definitions like:
      // attended: { name: 'Attended', styles: { width: '1360px', height: '768px' } }
      // Handle both single-line and multi-line formats
      const viewportDefinitions = optionsSection.match(
        /(\w+):\s*\{[\s\S]*?styles:\s*\{[\s\S]*?width:\s*['"](\d+)px['"][\s\S]*?height:\s*['"](\d+)px['"][\s\S]*?\}/g,
      );

      // Alternative approach: look for individual viewport definitions
      if (!viewportDefinitions) {
        // Look for patterns like: width: '1024px' and height: '768px' directly
        const widthMatches = optionsSection.match(/width:\s*['"](\d+)px['"]/g);
        const heightMatches = optionsSection.match(/height:\s*['"](\d+)px['"]/g);

        if (widthMatches && heightMatches && widthMatches.length === heightMatches.length) {
          // Find viewport names by looking backwards from width matches
          for (let i = 0; i < widthMatches.length; i++) {
            const widthMatch = widthMatches[i];
            const heightMatch = heightMatches[i];
            const width = parseInt(widthMatch.match(/width:\s*['"](\d+)px['"]/)![1]);
            const height = parseInt(heightMatch.match(/height:\s*['"](\d+)px['"]/)![1]);

            // Find the viewport name by looking backwards from the width match
            const beforeWidth = optionsSection.substring(0, optionsSection.indexOf(widthMatch));
            const nameMatch = beforeWidth.match(/(\w+):\s*\{[\s\S]*$/);
            if (nameMatch) {
              const name = nameMatch[1];
              config[name] = { width, height };
            }
          }
        }
      }

      if (viewportDefinitions) {
        for (const definition of viewportDefinitions) {
          const match = definition.match(
            /(\w+):\s*\{[\s\S]*?width:\s*['"](\d+)px['"][\s\S]*?height:\s*['"](\d+)px['"]/,
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

      if (Object.keys(config).length > 0) {
        // Store the default viewport in the config object for later use
        if (defaultViewport) {
          (config as any).__defaultViewport = defaultViewport;
        }
        return config;
      }
    }

    // Format 2: viewport.*?configurations.*?\{([^}]+)\} (original format)
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
            /(\w+):\s*\{[\s\S]*?width:\s*['"](\d+)px['"][\s\S]*?height:\s*['"](\d+)px['"]/,
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
        this.config.includeStories!.some((pattern) => {
          const lowerPattern = pattern.toLowerCase();
          const lowerStoryId = story.id.toLowerCase();
          const lowerTitle = story.title.toLowerCase();

          // Try glob pattern matching first, fallback to includes for backward compatibility
          try {
            const matcher = picomatch(lowerPattern, { nocase: true });
            return matcher(lowerStoryId) || matcher(lowerTitle);
          } catch {
            // Fallback to simple includes matching for backward compatibility
            return lowerStoryId.includes(lowerPattern) || lowerTitle.includes(lowerPattern);
          }
        }),
      );
    }

    // Apply exclude filter
    if (this.config.excludeStories && this.config.excludeStories.length > 0) {
      filtered = filtered.filter(
        (story) =>
          !this.config.excludeStories!.some((pattern) => {
            const lowerPattern = pattern.toLowerCase();
            const lowerStoryId = story.id.toLowerCase();
            const lowerTitle = story.title.toLowerCase();

            // Try glob pattern matching first, fallback to includes for backward compatibility
            try {
              const matcher = picomatch(lowerPattern, { nocase: true });
              return matcher(lowerStoryId) || matcher(lowerTitle);
            } catch {
              // Fallback to simple includes matching for backward compatibility
              return lowerStoryId.includes(lowerPattern) || lowerTitle.includes(lowerPattern);
            }
          }),
      );
    }

    return filtered;
  }
}
