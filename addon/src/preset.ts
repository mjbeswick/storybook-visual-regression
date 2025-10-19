import { startApiServer } from './server';

// Start the API server when Storybook loads
const DEFAULT_PORT = 6007;
let serverStarted = false;

export function managerEntries(entry: string[] = []) {
  return [...entry, require.resolve('./manager')];
}

export function previewAnnotations(entry: string[] = []) {
  // Start API server (only once)
  if (!serverStarted) {
    try {
      const port = process.env.VR_API_PORT ? parseInt(process.env.VR_API_PORT) : DEFAULT_PORT;
      startApiServer(port);
      serverStarted = true;
    } catch (error) {
      console.error('[Visual Regression] Failed to start API server:', error);
    }
  }

  return [...entry, require.resolve('./preview')];
}
