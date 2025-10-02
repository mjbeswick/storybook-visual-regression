import { readFileSync } from 'fs';
import { join } from 'path';
import type { StorybookIndex, StorybookEntry, VisualRegressionConfig } from '../types/index.js';

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
