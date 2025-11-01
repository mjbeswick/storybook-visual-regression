#!/usr/bin/env node
import path from 'node:path';
import { resolveConfig, saveEffectiveConfig, type CliFlags } from '../config.js';
import { Command } from '@commander-js/extra-typings';
import { run } from '../core/VisualRegressionRunner.js';
import { JsonRpcServer, CLI_METHODS, CLI_EVENTS } from '../jsonrpc.js';
import { setGlobalLogger, logger } from '../logger.js';

const parseArgs = (argv: string[]): CliFlags => {
  const out: CliFlags = {};
  const getVal = (i: number): string | undefined => argv[i + 1];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        /* no-op to mark presence */
        break;
      case '--log-level':
        out.logLevel = getVal(i) as any;
        i += 1;
        break;
      case '--config':
        out.config = getVal(i);
        i += 1;
        break;
      case '-u':
      case '--url':
        out.url = getVal(i);
        i += 1;
        break;
      case '-o':
      case '--output':
        out.output = getVal(i);
        i += 1;
        break;
      case '-w':
      case '--workers':
        out.workers = Number(getVal(i));
        i += 1;
        break;
      case '-c':
      case '--command':
        out.command = getVal(i);
        i += 1;
        break;
      case '--webserver-timeout':
        out.webserverTimeout = Number(getVal(i));
        i += 1;
        break;
      case '--retries':
        out.retries = Number(getVal(i));
        i += 1;
        break;
      case '--max-failures':
        out.maxFailures = Number(getVal(i));
        i += 1;
        break;
      case '--timezone':
        out.timezone = getVal(i);
        i += 1;
        break;
      case '--locale':
        out.locale = getVal(i);
        i += 1;
        break;
      case '--quiet':
        out.quiet = true;
        break;
      case '--debug':
        out.debug = true;
        break;
      case '--progress':
        out.showProgress = true;
        break;
      case '--summary':
        out.summary = true;
        break;
      case '--browser':
        out.browser = getVal(i) as any;
        i += 1;
        break;
      case '--threshold':
        out.threshold = Number(getVal(i));
        i += 1;
        break;
      case '--max-diff-pixels':
        out.maxDiffPixels = Number(getVal(i));
        i += 1;
        break;
      case '--full-page':
        out.fullPage = true;
        break;
      case '--overlay-timeout':
        out.overlayTimeout = Number(getVal(i));
        i += 1;
        break;
      case '--test-timeout':
        out.testTimeout = Number(getVal(i));
        i += 1;
        break;
      case '--snapshot-retries':
        out.snapshotRetries = Number(getVal(i));
        i += 1;
        break;
      case '--snapshot-delay':
        out.snapshotDelay = Number(getVal(i));
        i += 1;
        break;
      case '--mutation-wait':
        out.mutationWait = Number(getVal(i));
        i += 1;
        break;
      case '--mutation-timeout':
        out.mutationTimeout = Number(getVal(i));
        i += 1;
        break;
      case '--grep':
        out.grep = getVal(i);
        i += 1;
        break;
      case '--include':
        out.include = getVal(i);
        i += 1;
        break;
      case '--exclude':
        out.exclude = getVal(i);
        i += 1;
        break;
      case '--install-browsers':
        out.installBrowsers = getVal(i) ?? true;
        if (getVal(i)) i += 1;
        break;
      case '--install-deps':
        out.installDeps = true;
        break;
      case '--not-found-check':
        out.notFoundCheck = true;
        break;
      case '--not-found-retry-delay':
        out.notFoundRetryDelay = Number(getVal(i));
        i += 1;
        break;
      case '--update':
        out.update = true;
        break;
      case '--missing-only':
        out.missingOnly = true;
        break;
      case '--failed-only':
        out.failedOnly = true;
        break;
      case '--save-config':
        out.saveConfig = true;
        break;
      case '--fix-date':
        const fixDateVal = getVal(i);
        // Check if the next argument looks like a date value (not another flag)
        if (fixDateVal && !fixDateVal.startsWith('-')) {
          // If a value is provided, use it (could be timestamp or date string)
          out.fixDate = fixDateVal;
          i += 1;
        } else {
          // Just --fix-date without value means use default
          out.fixDate = true;
        }
        break;
      case '--json-rpc':
        out.jsonRpc = true;
        break;
      default:
        break;
    }
  }
  return out;
};

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);

  // Check for JSON-RPC mode first (before commander parsing)
  const flags = parseArgs(argv);
  if (flags.jsonRpc) {
    return await runJsonRpcMode(flags);
  }

  // Use commander for help/usage output and basic option declarations
  const program = new Command();
  program
    .name('svr')
    .description('Storybook Visual Regression CLI')
    .option('-u, --url <url>', 'Storybook URL (default http://localhost:6006)')
    .option('-o, --output <dir>', 'Output root (default visual-regression)')
    .option('-w, --workers <n>', 'Parallel workers')
    .option('--retries <n>', 'Playwright retries')
    .option('--max-failures <n>', 'Bail after N failures')
    .option('--browser <name>', 'chromium|firefox|webkit')
    .option('--threshold <0..1>', 'Diff threshold (default 0.2)')
    .option('--max-diff-pixels <n>', 'Max differing pixels (default 0)')
    .option('--full-page', 'Full page screenshots')
    .option('--mutation-wait <ms>', 'Quiet window wait (default 200)')
    .option('--mutation-timeout <ms>', 'Quiet wait cap (default 1000)')
    .option('--snapshot-retries <n>', 'Capture retries (default 1)')
    .option('--snapshot-delay <ms>', 'Delay between retries')
    .option('--include <patterns>', 'Comma-separated include filters')
    .option('--exclude <patterns>', 'Comma-separated exclude filters')
    .option('--grep <regex>', 'Filter by storyId')
    .option('--update', 'Update baselines')
    .option('--missing-only', 'Create only missing baselines')
    .option('--failed-only', 'Rerun only previously failed')
    .option('--progress', 'Show progress during run')
    .option('--summary', 'Show summary at the end')
    .option('--log-level <level>', 'silent|error|warn|info|debug')
    .option('--save-config', 'Write effective config JSON')
    .option('--quiet', 'Suppress per-test output')
    .option(
      '--fix-date [date]',
      'Fix Date object with fixed date (timestamp or ISO string, or omit for default)',
    )
    .helpOption('-h, --help', 'Show help');

  program.exitOverride();
  try {
    program.parse(['node', 'svr', ...argv]);
  } catch (err: any) {
    if (err?.code === 'commander.helpDisplayed') return 0;
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
    throw err;
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

// Main function now handles its own errors and exits
main().then((code) => process.exit(code));
