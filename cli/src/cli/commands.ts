import { Command } from '@commander-js/extra-typings';

/**
 * Create and configure the main CLI program with all commands
 * This module centralizes command definitions for better maintainability
 */
export function createMainProgram(): Command {
  const program = new Command();

  program
    .name('svr')
    .description('Storybook Visual Regression CLI')
    .allowExcessArguments(false)
    .configureHelp({ sortOptions: true })
    .option('--json-rpc', 'Enable JSON-RPC mode')
    .helpOption('-h, --help', 'Show help');

  return program;
}

/**
 * Create the 'test' command with all visual regression testing options
 * 
 * Examples:
 *   svr test                                          Run tests against http://localhost:6006
 *   svr test --url http://storybook.example.com     Run tests against custom URL
 *   svr test --workers 4 --max-failures 5           Run with 4 workers, stop after 5 failures
 *   svr test --failed-only                          Rerun only previously failed tests
 */
export function createTestCommand(): Command {
  return new Command('test')
    .description('Run visual regression tests')
    .allowExcessArguments(false)
    .configureHelp({ sortOptions: true })
    .option('--config <path>', 'Config file path')
    .option('-u, --url <url>', 'Storybook URL (default http://localhost:6006)')
    .option('-o, --output <dir>', 'Output root (default visual-regression)')
    .option('-w, --workers <n>', 'Parallel workers', Number)
    .option('-c, --command <cmd>', 'Command to run')
    .option('--webserver-timeout <ms>', 'Webserver timeout', Number)
    .option('--max-failures <n>', 'Bail after N failures', Number)
    .option('--timezone <tz>', 'Timezone')
    .option('--locale <locale>', 'Locale')
    .option('--browser <name>', 'chromium|firefox|webkit')
    .option('--threshold <0..1>', 'Diff threshold as percentage (default 0.2 = 0.2%)', Number)
    .option('--max-diff-pixels <n>', 'Max differing pixels (default 0)', Number)
    .option('--full-page', 'Full page screenshots')
    .option('--mutation-wait <ms>', 'Quiet window wait (default 200)', Number)
    .option('--mutation-timeout <ms>', 'Quiet wait cap (default 1000)', Number)
    .option('--dom-stability-quiet-period <ms>', 'DOM stability quiet period (default 300)', Number)
    .option('--dom-stability-max-wait <ms>', 'DOM stability max wait (default 2000)', Number)
    .option('--story-load-delay <ms>', 'Delay after storybook root found (default 1000)', Number)
    .option('--test-timeout <ms>', 'Test timeout in milliseconds (default 60000)', Number)
    .option('--overlay-timeout <ms>', 'Overlay timeout in milliseconds', Number)
    .option(
      '--include <patterns>',
      'Comma-separated include filters (supports wildcards * and normalizes spaces/slashes)',
    )
    .option(
      '--exclude <patterns>',
      'Comma-separated exclude filters (supports wildcards * and normalizes spaces/slashes)',
    )
    .option('--grep <regex>', 'Filter by storyId')
    .option('--missing-only', 'Create only missing baselines')
    .option('--failed-only', 'Rerun only previously failed')
    .option('--progress', 'Show progress during run')
    .option('--no-progress', 'Disable progress display')
    .option('--summary', 'Show summary at the end')
    .option('--no-summary', 'Disable summary display')
    .option('--log-level <level>', 'silent|error|warn|info|debug')
    .option('--save-config', 'Write effective config JSON')
    .option('--quiet', 'Suppress per-test output')
    .option('--debug', 'Enable debug logging')
    .option('--install-browsers [browser]', 'Install browsers (optionally specify browser)')
    .option('--install-deps', 'Install browser dependencies')
    .option('--not-found-check', 'Check for not found errors')
    .option(
      '--fix-date [date]',
      'Fix Date object with fixed date (timestamp or ISO string, or omit for default)',
    )
    .option('--results', 'Show results report after tests complete')
    .option(
      '--results-file [path]',
      'Write results report to file (defaults to results directory/report.txt if no path provided)',
    )
    .option('--all', 'Show all results (not just failed)')
    .option('--status <status>', 'Filter by status: passed|failed|new|missing');
}

/**
 * Create the 'update' command for creating/updating baselines
 * 
 * Examples:
 *   svr update                          Update all baseline snapshots
 *   svr update --missing-only           Create only missing baseline snapshots
 *   svr update --grep "Button"          Update only Button component stories
 */
export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Update or create snapshot baselines')
    .allowExcessArguments(false)
    .configureHelp({ sortOptions: true })
    .option('--config <path>', 'Config file path')
    .option('-u, --url <url>', 'Storybook URL (default http://localhost:6006)')
    .option('-o, --output <dir>', 'Output root (default visual-regression)')
    .option('-w, --workers <n>', 'Parallel workers', Number)
    .option('-c, --command <cmd>', 'Command to run')
    .option('--webserver-timeout <ms>', 'Webserver timeout', Number)
    .option('--max-failures <n>', 'Bail after N failures', Number)
    .option('--timezone <tz>', 'Timezone')
    .option('--locale <locale>', 'Locale')
    .option('--browser <name>', 'chromium|firefox|webkit')
    .option('--full-page', 'Full page screenshots')
    .option('--mutation-wait <ms>', 'Quiet window wait (default 200)', Number)
    .option('--mutation-timeout <ms>', 'Quiet wait cap (default 1000)', Number)
    .option('--dom-stability-quiet-period <ms>', 'DOM stability quiet period (default 300)', Number)
    .option('--dom-stability-max-wait <ms>', 'DOM stability max wait (default 2000)', Number)
    .option('--story-load-delay <ms>', 'Delay after storybook root found (default 1000)', Number)
    .option('--test-timeout <ms>', 'Test timeout in milliseconds (default 60000)', Number)
    .option('--overlay-timeout <ms>', 'Overlay timeout in milliseconds', Number)
    .option(
      '--include <patterns>',
      'Comma-separated include filters (supports wildcards * and normalizes spaces/slashes)',
    )
    .option(
      '--exclude <patterns>',
      'Comma-separated exclude filters (supports wildcards * and normalizes spaces/slashes)',
    )
    .option('--grep <regex>', 'Filter by storyId')
    .option('--missing-only', 'Create only missing baselines')
    .option('--progress', 'Show progress during run')
    .option('--no-progress', 'Disable progress display')
    .option('--summary', 'Show summary at the end')
    .option('--no-summary', 'Disable summary display')
    .option('--log-level <level>', 'silent|error|warn|info|debug')
    .option('--save-config', 'Write effective config JSON')
    .option('--quiet', 'Suppress per-test output')
    .option('--debug', 'Enable debug logging')
    .option('--install-browsers [browser]', 'Install browsers (optionally specify browser)')
    .option('--install-deps', 'Install browser dependencies')
    .option('--not-found-check', 'Check for not found errors')
    .option(
      '--fix-date [date]',
      'Fix Date object with fixed date (timestamp or ISO string, or omit for default)',
    );
}

/**
 * Create the 'snapshots' command for listing snapshots
 */
export function createSnapshotsCommand(): Command {
  return new Command('snapshots')
    .description('List all snapshots')
    .allowExcessArguments(false)
    .configureHelp({ sortOptions: true })
    .option('--config <path>', 'Config file path')
    .option('-o, --output <dir>', 'Output root (default visual-regression)')
    .option(
      '--include <patterns>',
      'Comma-separated include filters (supports wildcards * and normalizes spaces/slashes)',
    )
    .option(
      '--exclude <patterns>',
      'Comma-separated exclude filters (supports wildcards * and normalizes spaces/slashes)',
    )
    .option('--grep <regex>', 'Filter by storyId');
}

/**
 * Create the 'results' command for viewing test results
 */
export function createResultsCommand(): Command {
  return new Command('results')
    .description('List test results (shows failed by default)')
    .allowExcessArguments(false)
    .configureHelp({ sortOptions: true })
    .option('--config <path>', 'Config file path')
    .option('-o, --output <dir>', 'Output root (default visual-regression)')
    .option(
      '--output-file <path>',
      'Base path for relative file paths in output (paths will be relative to this file)',
    )
    .option(
      '--results-file [path]',
      'Write results report to file (defaults to results directory/report.txt if no path provided)',
    )
    .option('--all', 'Show all results (not just failed)')
    .option('--status <status>', 'Filter by status: passed|failed|new|missing')
    .option(
      '--include <patterns>',
      'Comma-separated include filters (supports wildcards * and normalizes spaces/slashes)',
    )
    .option(
      '--exclude <patterns>',
      'Comma-separated exclude filters (supports wildcards * and normalizes spaces/slashes)',
    )
    .option('--grep <regex>', 'Filter by storyId');
}

/**
 * Create the 'cleanup' command for cleaning up orphaned files
 */
export function createCleanupCommand(): Command {
  return new Command('cleanup')
    .description('Clean up orphaned files and directories in snapshots and results')
    .allowExcessArguments(false)
    .configureHelp({ sortOptions: true })
    .option('--config <path>', 'Config file path')
    .option('-o, --output <dir>', 'Output root (default visual-regression)')
    .option('--snapshots-only', 'Only clean up snapshots directory')
    .option('--results-only', 'Only clean up results directory');
}
