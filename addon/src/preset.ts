import { startApiServer } from './server';
import { loadAddonConfig } from './config';

let serverStarted = false;

export interface AddonOptions {
  port?: number;
  cliCommand?: string;
}

export function managerEntries(entry: string[] = []) {
  return [...entry, require.resolve('./manager')];
}

export function previewAnnotations(entry: string[] = [], options: AddonOptions = {}) {
  // Start API server (only once)
  if (!serverStarted) {
    try {
      const defaultConfig = loadAddonConfig();
      const port = options.port || defaultConfig.port;
      const cliCommand = options.cliCommand || defaultConfig.cliCommand;
      startApiServer(port, cliCommand);
      serverStarted = true;
    } catch {
      // ignore server startup errors
    }
  }

  return [...entry, require.resolve('./preview')];
}
