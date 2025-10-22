import { startApiServer } from './server';
import { loadAddonConfig } from './config';

let serverStarted = false;

export function managerEntries(entry: string[] = []) {
  return [...entry, require.resolve('./manager')];
}

export function previewAnnotations(entry: string[] = []) {
  // Start API server (only once)
  if (!serverStarted) {
    try {
      const config = loadAddonConfig();
      startApiServer(config.port, config.cliCommand);
      serverStarted = true;
    } catch {
      // ignore server startup errors
    }
  }

  return [...entry, require.resolve('./preview')];
}
