export interface AddonConfig {
  cliCommand?: string;
}

export interface ResolvedConfig {
  cliCommand: string;
}

const DEFAULT_CLI_COMMAND = 'npx @storybook-visual-regression/cli';

export function loadAddonConfig(): ResolvedConfig {
  // Always use explicit defaults; avoid env-based drift or port conflicts
  return {
    cliCommand: DEFAULT_CLI_COMMAND,
  };
}
