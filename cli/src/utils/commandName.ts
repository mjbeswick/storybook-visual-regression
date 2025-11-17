import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Get the command name dynamically from process.argv or package.json
 */
export function getCommandName(): string {
  // Try to get from process.argv[1] (the script path)
  if (process.argv[1]) {
    const scriptPath = process.argv[1];
    const scriptName = scriptPath.split(/[/\\]/).pop() || '';

    // If it's a node script or contains storybook-visual-regression, try package.json
    if (
      scriptName === 'index.js' ||
      scriptName.includes('storybook-visual-regression') ||
      scriptName.includes('node')
    ) {
      // Try to read package.json to get bin name
      try {
        const currentFile = fileURLToPath(import.meta.url);
        const packageJsonPath = join(dirname(currentFile), '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.bin) {
          const binName =
            typeof packageJson.bin === 'string' ? packageJson.bin : Object.keys(packageJson.bin)[0];
          if (binName) return binName;
        }
      } catch {
        // Fall through to default
      }
    }

    // Extract command name from path (e.g., /usr/local/bin/svr -> svr)
    if (
      scriptName &&
      !scriptName.includes('node') &&
      !scriptName.includes('.js') &&
      !scriptName.includes('.')
    ) {
      return scriptName;
    }
  }

  // Default fallback - try to detect from how the script was invoked
  // Check if running via npx
  if (process.env.npm_config_user_agent?.includes('npm')) {
    return 'npx @storybook-visual-regression/cli';
  }

  // Final fallback
  return 'svr';
}
