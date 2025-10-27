export interface AddonConfig {
  cliCommand?: string;
  storybookUrl?: string;
}

export interface ResolvedConfig {
  cliCommand: string;
  storybookUrl: string;
}

const DEFAULT_CLI_COMMAND = 'npx @storybook-visual-regression/cli';
const DEFAULT_STORYBOOK_URL = 'http://localhost:9009';

export function loadAddonConfig(): ResolvedConfig {
  // Always use explicit defaults; avoid env-based drift or port conflicts
  return {
    cliCommand: DEFAULT_CLI_COMMAND,
    storybookUrl: DEFAULT_STORYBOOK_URL,
  };
}
