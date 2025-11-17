#!/usr/bin/env node
import path from 'node:path';
import { resolveConfig, saveEffectiveConfig, type CliFlags } from '../config.js';
import { Command } from '@commander-js/extra-typings';
import { run } from '../core/VisualRegressionRunner.js';
import { JsonRpcServer, CLI_METHODS, CLI_EVENTS } from '../jsonrpc.js';
import { setGlobalLogger, logger } from '../logger.js';
import { listSnapshots } from '../core/ListSnapshots.js';
import { listResults } from '../core/ListResults.js';
import prompts from 'prompts';

/**
 * Calculate Levenshtein distance between two strings
 * Used for command suggestions
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];
  const len1 = str1.length;
  const len2 = str2.length;

  if (len1 === 0) return len2;
  if (len2 === 0) return len1;

  for (let i = 0; i <= len2; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len1; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len2; i++) {
    for (let j = 1; j <= len1; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  return matrix[len2][len1];
}

// Helper to convert Commander.js opts to CliFlags format
const optsToFlags = (opts: Record<string, unknown>): CliFlags => {
  const flags: CliFlags = {};

  // String options
  if (opts.config) flags.config = String(opts.config);
  if (opts.url) flags.url = String(opts.url);
  if (opts.output) flags.output = String(opts.output);
  if (opts.command) flags.command = String(opts.command);
  if (opts.timezone) flags.timezone = String(opts.timezone);
  if (opts.locale) flags.locale = String(opts.locale);
  if (opts.browser) flags.browser = opts.browser as 'chromium' | 'firefox' | 'webkit';
  if (opts.grep) flags.grep = String(opts.grep);
  if (opts.include) flags.include = String(opts.include);
  if (opts.exclude) flags.exclude = String(opts.exclude);
  if (opts.logLevel) flags.logLevel = opts.logLevel as CliFlags['logLevel'];

  // Number options
  if (opts.workers !== undefined) flags.workers = Number(opts.workers);
  if (opts.webserverTimeout !== undefined) flags.webserverTimeout = Number(opts.webserverTimeout);
  if (opts.retries !== undefined) flags.retries = Number(opts.retries);
  if (opts.maxFailures !== undefined) flags.maxFailures = Number(opts.maxFailures);
  if (opts.threshold !== undefined) flags.threshold = Number(opts.threshold);
  if (opts.maxDiffPixels !== undefined) flags.maxDiffPixels = Number(opts.maxDiffPixels);
  if (opts.overlayTimeout !== undefined) flags.overlayTimeout = Number(opts.overlayTimeout);
  if (opts.testTimeout !== undefined) flags.testTimeout = Number(opts.testTimeout);
  if (opts.snapshotRetries !== undefined) flags.snapshotRetries = Number(opts.snapshotRetries);
  if (opts.snapshotDelay !== undefined) flags.snapshotDelay = Number(opts.snapshotDelay);
  if (opts.mutationWait !== undefined) flags.mutationWait = Number(opts.mutationWait);
  if (opts.mutationTimeout !== undefined) flags.mutationTimeout = Number(opts.mutationTimeout);
  if (opts.domStabilityQuietPeriod !== undefined)
    flags.domStabilityQuietPeriod = Number(opts.domStabilityQuietPeriod);
  if (opts.domStabilityMaxWait !== undefined)
    flags.domStabilityMaxWait = Number(opts.domStabilityMaxWait);
  if (opts.storyLoadDelay !== undefined) flags.storyLoadDelay = Number(opts.storyLoadDelay);
  if (opts.notFoundRetryDelay !== undefined)
    flags.notFoundRetryDelay = Number(opts.notFoundRetryDelay);

  // Boolean options
  if (opts.quiet) flags.quiet = true;
  if (opts.debug) flags.debug = true;
  if (opts.fullPage) flags.fullPage = true;
  if (opts.update) flags.update = true;
  if (opts.missingOnly) flags.missingOnly = true;
  if (opts.failedOnly) flags.failedOnly = true;
  if (opts.saveConfig) flags.saveConfig = true;
  if (opts.installDeps) flags.installDeps = true;
  if (opts.notFoundCheck) flags.notFoundCheck = true;
  if (opts.jsonRpc) flags.jsonRpc = true;

  // Special boolean options that can be explicitly set to false
  if (opts.progress !== undefined) flags.showProgress = Boolean(opts.progress);
  if (opts.summary !== undefined) flags.summary = Boolean(opts.summary);

  // Special options
  if (opts.fixDate !== undefined) {
    // Commander.js handles [date] as optional - if present but no value, it's true
    if (opts.fixDate === true) {
      flags.fixDate = true;
    } else if (typeof opts.fixDate === 'string') {
      flags.fixDate = opts.fixDate;
    }
  }

  if (opts.installBrowsers !== undefined) {
    // Can be boolean (true) or string (browser name)
    if (opts.installBrowsers === true) {
      flags.installBrowsers = true;
    } else if (typeof opts.installBrowsers === 'string') {
      flags.installBrowsers = opts.installBrowsers;
    }
  }

  return flags;
};

const mainWithArgv = async (argv: string[]): Promise<number> => {

  // Use Commander.js for all argument parsing
  const program = new Command();
  
  // Store exit code for commands that execute
  let commandExitCode: number | null = null;
  
  program
    .name('svr')
    .description('Storybook Visual Regression CLI')
    .addCommand(
      new Command('test')
        .description('Run visual regression tests')
        .option('--config <path>', 'Config file path')
        .option('-u, --url <url>', 'Storybook URL (default http://localhost:6006)')
        .option('-o, --output <dir>', 'Output root (default visual-regression)')
        .option('-w, --workers <n>', 'Parallel workers', Number)
        .option('-c, --command <cmd>', 'Command to run')
        .option('--webserver-timeout <ms>', 'Webserver timeout', Number)
        .option('--retries <n>', 'Playwright retries', Number)
        .option('--max-failures <n>', 'Bail after N failures', Number)
        .option('--timezone <tz>', 'Timezone')
        .option('--locale <locale>', 'Locale')
        .option('--browser <name>', 'chromium|firefox|webkit')
        .option('--threshold <0..1>', 'Diff threshold (default 0.2)', Number)
        .option('--max-diff-pixels <n>', 'Max differing pixels (default 0)', Number)
        .option('--full-page', 'Full page screenshots')
        .option('--mutation-wait <ms>', 'Quiet window wait (default 200)', Number)
        .option('--mutation-timeout <ms>', 'Quiet wait cap (default 1000)', Number)
        .option('--dom-stability-quiet-period <ms>', 'DOM stability quiet period (default 300)', Number)
        .option('--dom-stability-max-wait <ms>', 'DOM stability max wait (default 2000)', Number)
        .option('--story-load-delay <ms>', 'Delay after storybook root found (default 1000)', Number)
        .option('--test-timeout <ms>', 'Test timeout in milliseconds (default 60000)', Number)
        .option('--overlay-timeout <ms>', 'Overlay timeout in milliseconds', Number)
        .option('--snapshot-retries <n>', 'Capture retries (default 1)', Number)
        .option('--snapshot-delay <ms>', 'Delay between retries', Number)
        .option('--include <patterns>', 'Comma-separated include filters')
        .option('--exclude <patterns>', 'Comma-separated exclude filters')
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
        .option('--not-found-retry-delay <ms>', 'Retry delay for not found errors', Number)
        .option('--json-rpc', 'Enable JSON-RPC mode')
        .option(
          '--fix-date [date]',
          'Fix Date object with fixed date (timestamp or ISO string, or omit for default)',
        )
        .action(async (opts) => {
          try {
            const flags = optsToFlags(opts);
            const config = resolveConfig(flags);
            setGlobalLogger(config.logLevel);
            const code = await run(config);
            commandExitCode = code;
            // Don't throw - let the main function handle the exit code
          } catch (err) {
            logger.error(`Error in test command: ${err instanceof Error ? err.message : String(err)}`);
            commandExitCode = 1;
          }
        })
    )
    .addCommand(
      new Command('update')
        .description('Update or create snapshot baselines')
        .option('--config <path>', 'Config file path')
        .option('-u, --url <url>', 'Storybook URL (default http://localhost:6006)')
        .option('-o, --output <dir>', 'Output root (default visual-regression)')
        .option('-w, --workers <n>', 'Parallel workers', Number)
        .option('-c, --command <cmd>', 'Command to run')
        .option('--webserver-timeout <ms>', 'Webserver timeout', Number)
        .option('--retries <n>', 'Playwright retries', Number)
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
        .option('--snapshot-retries <n>', 'Capture retries (default 1)', Number)
        .option('--snapshot-delay <ms>', 'Delay between retries', Number)
        .option('--include <patterns>', 'Comma-separated include filters')
        .option('--exclude <patterns>', 'Comma-separated exclude filters')
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
        .option('--not-found-retry-delay <ms>', 'Retry delay for not found errors', Number)
        .option(
          '--fix-date [date]',
          'Fix Date object with fixed date (timestamp or ISO string, or omit for default)',
        )
        .action(async (opts) => {
          try {
            const flags = optsToFlags(opts);
            flags.update = true; // Set update flag
            const config = resolveConfig(flags);
            setGlobalLogger(config.logLevel);
            const code = await run(config);
            commandExitCode = code;
            // Don't throw - let the main function handle the exit code
          } catch (err) {
            logger.error(`Error in update command: ${err instanceof Error ? err.message : String(err)}`);
            commandExitCode = 1;
          }
        })
    )
    .addCommand(
      new Command('snapshots')
        .description('List all snapshots')
        .option('--config <path>', 'Config file path')
        .option('-o, --output <dir>', 'Output root (default visual-regression)')
        .action(async (opts) => {
          const flags = optsToFlags(opts);
          const config = resolveConfig(flags);
          setGlobalLogger(config.logLevel);
          listSnapshots(config);
          commandExitCode = 0;
        })
    )
    .addCommand(
      new Command('results')
        .description('List test results (shows failed by default)')
        .option('--config <path>', 'Config file path')
        .option('-o, --output <dir>', 'Output root (default visual-regression)')
        .option('--all', 'Show all results (not just failed)')
        .option('--status <status>', 'Filter by status: passed|failed|new|missing')
        .action(async (opts) => {
          const flags = optsToFlags(opts);
          const config = resolveConfig(flags);
          setGlobalLogger(config.logLevel);
          // If --all is specified, don't filter; if --status is specified, use it; otherwise default to 'failed'
          const status = opts.all ? undefined : (opts.status || 'failed');
          listResults(config, { status: status as any });
          commandExitCode = 0;
        })
    )
    // Default action: if no subcommand provided, show help
    .action(async () => {
      try {
        program.help();
      } catch (err: any) {
        // Help display throws an error, but we want to exit gracefully
        if (err?.code === 'commander.help' || err?.code === 'commander.helpDisplayed') {
          return;
        }
        throw err;
      }
    })
    .helpOption('-h, --help', 'Show help');

  program.exitOverride();
  
  let parsedOpts: Record<string, unknown>;
  try {
    await program.parseAsync(['node', 'svr', ...argv]);
    parsedOpts = program.opts();
    
    // If a command set an exit code, return it
    if (commandExitCode !== null) {
      return commandExitCode;
    }
    
    // Check if a subcommand was executed by checking if argv[0] matches a known command
    const subcommands = ['test', 'update', 'snapshots', 'results'];
    const executedCommand = argv[0];
    if (executedCommand && subcommands.includes(executedCommand)) {
      // A subcommand was executed - it should have set commandExitCode
      // If we reach here, something went wrong, but don't run fallback code
      return commandExitCode ?? 0;
    }
  } catch (err: any) {
    // Handle help display gracefully
    if (err?.code === 'commander.helpDisplayed' || err?.code === 'commander.help') {
      return 0;
    }
    
    // Handle unknown commands with suggestions
    if (err?.code === 'commander.unknownCommand') {
      const unknownCmd = err.args?.[0] || argv[0];
      const availableCommands = ['test', 'update', 'snapshots', 'results'];
      
      // Find similar commands
      const suggestions = availableCommands.filter(cmd => {
        const distance = levenshteinDistance(unknownCmd.toLowerCase(), cmd.toLowerCase());
        return distance <= 2 && distance < cmd.length;
      });
      
      console.error(`\nUnknown command: ${unknownCmd}`);
      if (suggestions.length > 0) {
        console.error(`\nDid you mean one of these?`);
        suggestions.forEach(cmd => console.error(`  ${cmd}`));
      } else {
        console.error(`\nAvailable commands: ${availableCommands.join(', ')}`);
      }
      console.error(`\nRun 'svr --help' for more information.\n`);
      return 1;
    }
    
    if (err?.code === 'commander.unknownOption') {
      console.error('');
      if (err.message?.includes('--mock-date')) {
        console.error('Did you mean to use --fix-date instead of --mock-date?');
        console.error('The --mock-date flag has been renamed to --fix-date.');
      } else {
        console.error('Unknown option provided.');
      }
      console.error('');
      console.error('Run with --help to see all available options.');
      return 1;
    }
    
    // Re-throw other errors
    throw err;
  }

  // Check if a subcommand was executed - if so, don't run fallback code
  const subcommands = ['test', 'update', 'snapshots', 'results'];
  const executedCommand = argv[0];
  
  // If a command was provided but it's not a valid subcommand, return error
  if (executedCommand && !subcommands.includes(executedCommand)) {
    console.error(`\nUnknown command: ${executedCommand}`);
    const suggestions = subcommands.filter(cmd => {
      const distance = levenshteinDistance(executedCommand.toLowerCase(), cmd.toLowerCase());
      return distance <= 2 && distance < cmd.length;
    });
    if (suggestions.length > 0) {
      console.error(`\nDid you mean one of these?`);
      suggestions.forEach(cmd => console.error(`  ${cmd}`));
    } else {
      console.error(`\nAvailable commands: ${subcommands.join(', ')}`);
    }
    console.error(`\nRun 'svr --help' for more information.\n`);
    return 1;
  }
  
  if (executedCommand && subcommands.includes(executedCommand)) {
    // A subcommand was executed - it should have handled everything and exited
    // If we reach here, return gracefully
    return 0;
  }

  // No command provided - show interactive prompt
  if (!executedCommand) {
    try {
      const response = await prompts({
        type: 'select',
        name: 'command',
        message: 'What would you like to do?',
        choices: [
          { title: 'Run visual regression tests', value: 'test', description: 'Execute visual regression tests' },
          { title: 'Update snapshot baselines', value: 'update', description: 'Update or create snapshot baselines' },
          { title: 'List snapshots', value: 'snapshots', description: 'Show all stored snapshots' },
          { title: 'List test results', value: 'results', description: 'Show test results' },
        ],
      });

      if (!response.command) {
        // User cancelled (Ctrl+C)
        return 0;
      }

      // Re-parse with the selected command
      const newArgv = [response.command, ...argv.slice(1)];
      return await mainWithArgv(newArgv);
    } catch (err) {
      // Handle cancellation gracefully
      if ((err as any)?.name === 'ExitPrompt') {
        return 0;
      }
      throw err;
    }
  }

  // Convert Commander.js opts to CliFlags format
  const flags = optsToFlags(parsedOpts);

  // Check for JSON-RPC mode after parsing
  if (flags.jsonRpc) {
    return await runJsonRpcMode(flags);
  }

  let config;
  try {
    config = resolveConfig(flags);
    // Initialize global logger with resolved log level
    setGlobalLogger(config.logLevel);

    if (flags.saveConfig) {
      const configPath = path.join(config.outputDir, 'config.json');
      saveEffectiveConfig(config, flags, configPath);
    }
    const code = await run(config);
    return code;
  } catch (err) {
    // Determine if debug logging is enabled
    const isDebug = flags.debug || flags.logLevel === 'debug';

    if (isDebug) {
      // Show full error with stack trace for debugging
      logger.error('Debug mode enabled, showing full error:');
      logger.error(err);
    } else {
      // Show only user-friendly error message
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Error: ${message}`);
    }

    return 2;
  }
};

const runJsonRpcMode = async (flags: CliFlags): Promise<number> => {
  const config = resolveConfig(flags);
  // Initialize global logger with resolved log level
  setGlobalLogger(config.logLevel);
  const server = new JsonRpcServer();

  // Current run state
  let currentRun: { cancel: () => void } | null = null;
  let isRunning = false;

  // Send ready notification
  server.notify(CLI_EVENTS.READY, { version: '1.0.0' });

  // Register method handlers
  server.on(CLI_METHODS.RUN, async (params) => {
    if (isRunning) {
      throw new Error('A test run is already in progress');
    }

    isRunning = true;
    server.notify(CLI_EVENTS.PROGRESS, { running: true, completed: 0, total: 0 });

    try {
      // Merge provided params with base config
      const runConfig = { ...config };

      // Override config with params
      if (params) {
        Object.assign(runConfig, params);
      }

      // Create a promise that can be cancelled
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
      };

      currentRun = { cancel };

      // Set up progress callbacks
      const progressCallback = (progress: any) => {
        server.notify(CLI_EVENTS.PROGRESS, progress);
      };

      const storyStartCallback = (storyId: string, storyName: string) => {
        server.notify(CLI_EVENTS.STORY_START, { storyId, storyName });
      };

      const storyCompleteCallback = (result: any) => {
        server.notify(CLI_EVENTS.STORY_COMPLETE, result);
      };

      const resultCallback = (result: any) => {
        server.notify(CLI_EVENTS.RESULT, result);
      };

      const logCallback = (message: string) => {
        server.notify(CLI_EVENTS.LOG, { message });
      };

      // Run the tests with callbacks
      const code = await run(runConfig, {
        onProgress: progressCallback,
        onStoryStart: storyStartCallback,
        onStoryComplete: storyCompleteCallback,
        onResult: resultCallback,
        onLog: logCallback,
        cancelled: () => cancelled,
      });

      server.notify(CLI_EVENTS.COMPLETE, { code, cancelled });
      return { code, cancelled };
    } catch (error) {
      server.notify(CLI_EVENTS.ERROR, {
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      isRunning = false;
      currentRun = null;
      server.notify(CLI_EVENTS.PROGRESS, { running: false });
    }
  });

  server.on(CLI_METHODS.CANCEL, async () => {
    if (currentRun) {
      currentRun.cancel();
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  server.on(CLI_METHODS.SET_CONFIG, async (newConfig) => {
    // Update config (this would merge with existing config)
    Object.assign(config, newConfig);
    return { updated: true };
  });

  server.on(CLI_METHODS.GET_CONFIG, async () => {
    return config;
  });

  server.on(CLI_METHODS.GET_STATUS, async () => {
    return {
      isRunning,
      currentRun: currentRun ? true : false,
    };
  });

  server.on(CLI_METHODS.GET_RESULTS, async () => {
    // This would need to be implemented to return current results
    // For now, return empty array
    return [];
  });

  // Start the server
  server.start();

  // Keep the process alive
  return new Promise(() => {
    // Never resolve - process stays alive until killed
  });
};

// Main function wrapper that uses process.argv
const main = async (): Promise<number> => {
  return mainWithArgv(process.argv.slice(2));
};

// Main function now handles its own errors and exits
main().then((code) => process.exit(code));
