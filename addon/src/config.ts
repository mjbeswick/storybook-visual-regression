export interface AddonConfig {
  port?: number;
  cliCommand?: string;
}

export interface ResolvedConfig {
  port: number;
  cliCommand: string;
}

const DEFAULT_PORT = 6007;
const DEFAULT_CLI_COMMAND = 'npx @storybook-visual-regression/cli';

export function loadAddonConfig(): ResolvedConfig {
  // Always use explicit defaults; avoid env-based drift or port conflicts
  return {
    port: DEFAULT_PORT,
    cliCommand: DEFAULT_CLI_COMMAND,
  };
}

export function getApiBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}
