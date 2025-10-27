import { startApiServer } from './server.js';
import { loadAddonConfig } from './config.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let serverStarted = false;

export interface AddonOptions {
  cliCommand?: string;
  storybookUrl?: string;
}

export function managerEntries(entry: string[] = []) {
  return [...entry, require.resolve('./manager')];
}

export function previewAnnotations(entry: string[] = [], options: AddonOptions = {}) {
  // Start API server (only once)
  if (!serverStarted) {
    try {
      const defaultConfig = loadAddonConfig();
      // Use fixed port 6007 for the addon's API server
      const port = 6007;
      const cliCommand = options.cliCommand || defaultConfig.cliCommand;
      const storybookUrl = options.storybookUrl || 'http://localhost:9009';
      startApiServer(port, cliCommand, storybookUrl);
      serverStarted = true;
    } catch {
      // ignore server startup errors
    }
  }

  return [...entry, require.resolve('./preview')];
}
