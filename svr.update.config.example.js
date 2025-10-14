/**
 * Storybook Visual Regression - Update/Baseline Config
 * 
 * Use this config for creating/updating snapshots.
 * It has longer timeouts and more stable settings than test config.
 * 
 * Usage: storybook-visual-regression update --config svr.update.config.js
 */

export default {
  url: 'http://localhost',
  port: 9009,
  command: 'npm run storybook',

  // Update mode benefits from fewer workers to avoid timeouts
  workers: 8,
  retries: 1,  // Retry once if there's a timeout
  maxFailures: 0, // Don't stop on failures during updates

  // Longer timeouts for complex screens
  navTimeout: 15000,       // 15s for navigation
  waitTimeout: 60000,      // 60s for element waits
  overlayTimeout: 10000,   // 10s for Storybook overlays
  stabilizeInterval: 200,  // Check every 200ms
  stabilizeAttempts: 30,   // Try for 6s (30 * 200ms)
  finalSettle: 1000,       // 1s final settle for complex screens
  
  // Use networkidle for more stability during updates
  waitUntil: 'networkidle',

  // Browser settings
  browser: 'chromium',
  timezone: 'Europe/London',
  locale: 'en-GB',
};

