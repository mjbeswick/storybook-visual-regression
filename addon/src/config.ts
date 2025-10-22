export interface AddonConfig {
  port?: number;
  cliCommand?: string;
}

export interface ResolvedConfig {
  port: number;
  cliCommand: string;
}

const DEFAULT_PORT = 6007;
const DEFAULT_CLI_COMMAND = 'storybook-visual-regression';

export function loadAddonConfig(): ResolvedConfig {
  // Check for environment variables first
  const port = process.env.VR_API_PORT ? parseInt(process.env.VR_API_PORT) : DEFAULT_PORT;
  const cliCommand = process.env.VR_CLI_COMMAND || DEFAULT_CLI_COMMAND;

  return {
    port,
    cliCommand,
  };
}

export function getApiBaseUrl(port: number): string {
  return `http://localhost:${port}`;
}
