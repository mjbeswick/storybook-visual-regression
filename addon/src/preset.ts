import { startApiServer } from './server.js';
import { loadAddonConfig } from './config.js';

let serverStarted = false;

export interface AddonOptions {
  port?: number;
  cliCommand?: string;
}

export function managerEntries(entry: string[] = []) {
  return [...entry, require.resolve('./manager.js')];
}

export function previewAnnotations(entry: string[] = [], options: AddonOptions = {}) {
  // Start API server (only once)
  if (!serverStarted) {
    try {
      const defaultConfig = loadAddonConfig();
      // Always use our default port, ignore Storybook's port to avoid conflicts
      const port = defaultConfig.port;
      const cliCommand = options.cliCommand || defaultConfig.cliCommand;
      startApiServer(port, cliCommand);
      serverStarted = true;
    } catch {
      // ignore server startup errors
    }
  }

  return [...entry, require.resolve('./preview.js')];
}
