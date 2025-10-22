import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const defaultConfigTemplate = `/**
 * Storybook Visual Regression Configuration
 * 
 * This file allows you to configure default settings for visual regression testing.
 * CLI options will override these settings when provided.
 */

export default {
  // Storybook server configuration
  url: 'http://localhost',
  port: 9009,
  command: 'npm run storybook', // Comment out if Storybook is already running

  // Test execution
  workers: 16,              // Number of parallel workers
  retries: 0,               // Number of retries on failure
  maxFailures: 10,          // Stop after N failures (0 = no limit)
  output: 'visual-regression', // Output directory for results

  // Browser settings
  browser: 'chromium',      // 'chromium' | 'firefox' | 'webkit'
  timezone: 'Europe/London',
  locale: 'en-GB',

  // Performance tuning - adjust these for faster/more stable tests
  navTimeout: 10000,        // Navigation timeout (ms)
  waitTimeout: 30000,       // Wait-for-element timeout (ms)
  overlayTimeout: 5000,     // Storybook overlay timeout (ms)
  webserverTimeout: 120000, // Webserver startup timeout (ms)
  stabilizeInterval: 150,   // Interval between stability checks (ms)
  stabilizeAttempts: 20,    // Number of stability checks
  finalSettle: 500,         // Final settle delay after readiness (ms)
  resourceSettle: 100,      // Time to wait after resource loads before considering all resources settled (ms)
  
  // Wait strategy: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
  // 'domcontentloaded' is faster, 'networkidle' is more stable
  waitUntil: 'networkidle',

  // Story filtering (optional)
  // include: ['Components/*', 'Screens/*'],
  // exclude: ['**/Docs', '**/Experimental'],
  // grep: 'button|modal',

  // Display options
  quiet: false,             // Suppress verbose failure output
  debug: false,             // Enable debug logging
  printUrls: false,         // Show story URLs inline with test results
  hideTimeEstimates: false, // Hide time estimates in progress display
  hideSpinners: false,      // Hide progress spinners (useful for CI)

  // Advanced options
  notFoundCheck: false,     // Enable 'Not Found' content heuristic
  notFoundRetryDelay: 200,  // Delay between Not Found retries (ms)

  // Reporter (optional)
  // reporter: 'list',      // Playwright reporter: 'list' | 'line' | 'dot' | 'json' | 'junit'
};
`;

const jsonConfigTemplate = `{
  "url": "http://localhost",
  "port": 9009,
  "command": "npm run storybook",
  "workers": 16,
  "retries": 0,
  "maxFailures": 10,
  "output": "visual-regression",
  "browser": "chromium",
  "timezone": "Europe/London",
  "locale": "en-GB",
  "navTimeout": 10000,
  "waitTimeout": 30000,
  "overlayTimeout": 5000,
  "webserverTimeout": 120000,
  "stabilizeInterval": 0,
  "stabilizeAttempts": 0,
  "finalSettle": 500,
  "resourceSettle": 100,
  "waitUntil": "networkidle",
  "quiet": false,
  "debug": false,
  "printUrls": false,
  "hideTimeEstimates": false,
  "hideSpinners": false,
  "notFoundCheck": false,
  "notFoundRetryDelay": 200
}
`;

export type ConfigFormat = 'js' | 'ts' | 'json';

export function initConfig(cwd: string, format: ConfigFormat = 'js', force: boolean = false): void {
  const fileNames: Record<ConfigFormat, string> = {
    js: 'svr.config.js',
    ts: 'svr.config.ts',
    json: '.svrrc.json',
  };

  const templates: Record<ConfigFormat, string> = {
    js: defaultConfigTemplate,
    ts: defaultConfigTemplate,
    json: jsonConfigTemplate,
  };

  const fileName = fileNames[format];
  const filePath = join(cwd, fileName);

  // Check if file already exists
  if (existsSync(filePath) && !force) {
    console.log(chalk.yellow(`⚠️  Config file already exists: ${fileName}`));
    console.log(chalk.dim('Use --force to overwrite'));
    process.exit(1);
  }

  // Write config file
  try {
    writeFileSync(filePath, templates[format], 'utf-8');
    console.log(chalk.green(`✓ Created config file: ${chalk.cyan(fileName)}`));
    console.log();
    console.log(chalk.dim('Next steps:'));
    console.log(chalk.dim(`1. Edit ${fileName} to customize settings`));
    console.log(chalk.dim('2. Run: storybook-visual-regression test'));
    console.log();
  } catch (error) {
    console.error(
      chalk.red(
        `Failed to create config file: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }
}
