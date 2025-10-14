/**
 * Storybook Visual Regression Configuration Example
 * 
 * Copy this file to svr.config.js and customize to your needs.
 * CLI options will override these settings when provided.
 * 
 * Run `storybook-visual-regression init` to create a config file.
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

