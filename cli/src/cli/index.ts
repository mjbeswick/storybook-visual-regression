#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { resolveConfig, saveEffectiveConfig, type CliFlags } from '../config.js';
import { Command } from '@commander-js/extra-typings';
import { run } from '../core/VisualRegressionRunner.js';
import { JsonRpcServer, CLI_METHODS, CLI_EVENTS } from '../jsonrpc.js';
import { setGlobalLogger, logger } from '../logger.js';
import { listSnapshots } from '../core/ListSnapshots.js';
import { listResults } from '../core/ListResults.js';
import { SnapshotIndexManager } from '../core/SnapshotIndex.js';
import { ResultsIndexManager } from '../core/ResultsIndex.js';
import { getCommandName } from '../utils/commandName.js';
import { EXIT_CODES } from '../parallel-runner.js';

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
  if (opts.maxFailures !== undefined) flags.maxFailures = Number(opts.maxFailures);
  if (opts.threshold !== undefined) flags.threshold = Number(opts.threshold);
  if (opts.maxDiffPixels !== undefined) flags.maxDiffPixels = Number(opts.maxDiffPixels);
  if (opts.overlayTimeout !== undefined) flags.overlayTimeout = Number(opts.overlayTimeout);
  if (opts.testTimeout !== undefined) flags.testTimeout = Number(opts.testTimeout);
  if (opts.mutationWait !== undefined) flags.mutationWait = Number(opts.mutationWait);
  if (opts.mutationTimeout !== undefined) flags.mutationTimeout = Number(opts.mutationTimeout);
  if (opts.domStabilityQuietPeriod !== undefined)
    flags.domStabilityQuietPeriod = Number(opts.domStabilityQuietPeriod);
  if (opts.domStabilityMaxWait !== undefined)
    flags.domStabilityMaxWait = Number(opts.domStabilityMaxWait);
  if (opts.storyLoadDelay !== undefined) flags.storyLoadDelay = Number(opts.storyLoadDelay);

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

  const cmdName = getCommandName();

  program
    .name(cmdName)
    .description('Storybook Visual Regression CLI')
    .allowExcessArguments(false)
    .configureHelp({ sortOptions: true })
    .option('--json-rpc', 'Enable JSON-RPC mode')
    .addCommand(
      new Command('test')
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
        .option(
          '--dom-stability-quiet-period <ms>',
          'DOM stability quiet period (default 300)',
          Number,
        )
        .option('--dom-stability-max-wait <ms>', 'DOM stability max wait (default 2000)', Number)
        .option(
          '--story-load-delay <ms>',
          'Delay after storybook root found (default 1000)',
          Number,
        )
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
        .option('--status <status>', 'Filter by status: passed|failed|new|missing')
        .action(async (opts) => {
          try {
            const flags = optsToFlags(opts);
            const config = resolveConfig(flags);
            setGlobalLogger(config.logLevel);
            const code = await run(config);
            commandExitCode = code;

            // Show report if requested
            if (opts.results || opts.resultsFile !== undefined) {
              // Default to showing only failed results unless --all is explicitly passed
              // Note: --include/--exclude/--grep filter which stories are tested, not which results are shown
              const status = opts.all ? undefined : opts.status || 'failed';

              // Determine output file path
              let outputFile: string | undefined;
              if (opts.resultsFile !== undefined) {
                // If --results-file is used without a value, use default path
                if (opts.resultsFile === true || opts.resultsFile === '') {
                  outputFile = path.join(config.resolvePath(config.resultsPath), 'report.txt');
                } else {
                  const outputPath = String(opts.resultsFile);
                  // Resolve relative paths to absolute paths
                  const resolvedPath = path.isAbsolute(outputPath)
                    ? outputPath
                    : path.resolve(process.cwd(), outputPath);
                  // If it's a directory or no extension, treat as directory and add default filename
                  if (
                    !path.extname(resolvedPath) ||
                    (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory())
                  ) {
                    outputFile = path.join(resolvedPath, 'report.txt');
                  } else {
                    outputFile = resolvedPath;
                  }
                }
                // Ensure the output file path is absolute
                if (outputFile && !path.isAbsolute(outputFile)) {
                  outputFile = path.resolve(process.cwd(), outputFile);
                }
              }
              // If only --results is used (without --results-file), outputFile remains undefined
              // which causes listResults to display to console instead of writing to file

              listResults(config, {
                status: status as any,
                include: config.includeStories,
                exclude: config.excludeStories,
                grep: config.grep,
                outputFile,
              });
            }
            // Don't throw - let the main function handle the exit code
          } catch (err) {
            logger.error(
              `Error in test command: ${err instanceof Error ? err.message : String(err)}`,
            );
            commandExitCode = 1;
          }
        }),
    )
    .addCommand(
      new Command('update')
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
        .option(
          '--dom-stability-quiet-period <ms>',
          'DOM stability quiet period (default 300)',
          Number,
        )
        .option('--dom-stability-max-wait <ms>', 'DOM stability max wait (default 2000)', Number)
        .option(
          '--story-load-delay <ms>',
          'Delay after storybook root found (default 1000)',
          Number,
        )
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
            logger.error(
              `Error in update command: ${err instanceof Error ? err.message : String(err)}`,
            );
            commandExitCode = 1;
          }
        }),
    )
    .addCommand(
      new Command('snapshots')
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
        .option('--grep <regex>', 'Filter by storyId')
        .action(async (opts) => {
          const flags = optsToFlags(opts);
          const config = resolveConfig(flags);
          setGlobalLogger(config.logLevel);
          listSnapshots(config, {
            include: config.includeStories,
            exclude: config.excludeStories,
            grep: config.grep,
          });
          commandExitCode = 0;
        }),
    )
    .addCommand(
      new Command('results')
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
        .option('--grep <regex>', 'Filter by storyId')
        .action(async (opts) => {
          const flags = optsToFlags(opts);
          const config = resolveConfig(flags);
          setGlobalLogger(config.logLevel);

          // If --grep, --include, or --exclude is used, implicitly show all results
          const hasFiltering = !!(opts.grep || opts.include || opts.exclude);
          const showAll = opts.all || hasFiltering;

          // If --all is specified or filtering is used, don't filter by status;
          // if --status is specified, use it; otherwise default to 'failed'
          const status = showAll ? undefined : opts.status || 'failed';

          // Determine output file path
          let outputFile: string | undefined;
          if (opts.resultsFile !== undefined) {
            // If --results-file is used without a value, use default path
            if (opts.resultsFile === true || opts.resultsFile === '') {
              outputFile = path.join(config.resolvePath(config.resultsPath), 'report.txt');
            } else {
              const outputPath = String(opts.resultsFile);
              // Resolve relative paths to absolute paths
              const resolvedPath = path.isAbsolute(outputPath)
                ? outputPath
                : path.resolve(process.cwd(), outputPath);
              // If it's a directory or no extension, treat as directory and add default filename
              if (
                !path.extname(resolvedPath) ||
                (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory())
              ) {
                outputFile = path.join(resolvedPath, 'report.txt');
              } else {
                outputFile = resolvedPath;
              }
            }
            // Ensure the output file path is absolute
            if (outputFile && !path.isAbsolute(outputFile)) {
              outputFile = path.resolve(process.cwd(), outputFile);
            }
          }

          listResults(config, {
            status: status as any,
            include: config.includeStories,
            exclude: config.excludeStories,
            grep: config.grep,
            outputPath: opts.outputFile,
            outputFile,
          });
          commandExitCode = 0;
        }),
    )
    .addCommand(
      new Command('cleanup')
        .description('Clean up orphaned files and directories in snapshots and results')
        .allowExcessArguments(false)
        .configureHelp({ sortOptions: true })
        .option('--config <path>', 'Config file path')
        .option('-o, --output <dir>', 'Output root (default visual-regression)')
        .option('--snapshots-only', 'Only clean up snapshots directory')
        .option('--results-only', 'Only clean up results directory')
        .action(async (opts) => {
          const flags = optsToFlags(opts);
          const config = resolveConfig(flags);
          setGlobalLogger(config.logLevel);

          const snapshotsDir = config.resolvePath(config.snapshotPath);
          const resultsDir = config.resolvePath(config.resultsPath);

          let cleanedSnapshots = false;
          let cleanedResults = false;

          // Clean up snapshots
          if (!opts.resultsOnly) {
            if (fs.existsSync(snapshotsDir)) {
              const indexManager = new SnapshotIndexManager(snapshotsDir);

              // Clean up orphaned entries (entries without files)
              indexManager.cleanupOrphanedEntries(snapshotsDir);

              // Clean up orphaned files (files without entries)
              const fileCleanup = indexManager.cleanupOrphanedFiles(snapshotsDir);

              if (fileCleanup.deletedFiles > 0 || fileCleanup.deletedDirectories > 0) {
                console.log(
                  `Cleaned up ${fileCleanup.deletedFiles} orphaned snapshot file(s) and ${fileCleanup.deletedDirectories} empty director${fileCleanup.deletedDirectories === 1 ? 'y' : 'ies'}`,
                );
                cleanedSnapshots = true;
              }

              // Flush index updates
              indexManager.flush();
            } else {
              console.log('Snapshots directory does not exist, skipping cleanup.');
            }
          }

          // Clean up results
          if (!opts.snapshotsOnly) {
            if (fs.existsSync(resultsDir)) {
              const resultsIndexManager = new ResultsIndexManager(resultsDir);

              // Clean up orphaned entries (entries without files)
              resultsIndexManager.cleanupOrphanedEntries(resultsDir);

              // Clean up duplicate entries (same storyId/browser with different viewportNames)
              const duplicateCleanup = resultsIndexManager.cleanupDuplicateEntries();
              if (duplicateCleanup.deletedEntries > 0) {
                console.log(`Cleaned up ${duplicateCleanup.deletedEntries} duplicate result entr${duplicateCleanup.deletedEntries === 1 ? 'y' : 'ies'}`);
                cleanedResults = true;
              }

              // Clean up orphaned files (files without entries)
              const fileCleanup = resultsIndexManager.cleanupOrphanedFiles(resultsDir);

              if (fileCleanup.deletedFiles > 0 || fileCleanup.deletedDirectories > 0) {
                console.log(
                  `Cleaned up ${fileCleanup.deletedFiles} orphaned result file(s) and ${fileCleanup.deletedDirectories} empty director${fileCleanup.deletedDirectories === 1 ? 'y' : 'ies'}`,
                );
                cleanedResults = true;
              }

              // Flush index updates
              resultsIndexManager.flush();
            } else {
              console.log('Results directory does not exist, skipping cleanup.');
            }
          }

          if (!cleanedSnapshots && !cleanedResults) {
            console.log('No orphaned files or directories found.');
          }

          commandExitCode = 0;
        }),
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

  // Check for JSON-RPC mode early (before parsing, so it works with any command or no command)
  if (argv.includes('--json-rpc')) {
    // Remove --json-rpc from argv and parse remaining args to get other options
    const jsonRpcIndex = argv.indexOf('--json-rpc');
    const argvWithoutJsonRpc = [...argv];
    argvWithoutJsonRpc.splice(jsonRpcIndex, 1);

    // If there are no other args, skip parsing to avoid showing help
    // Otherwise, parse to get config options
    let parsedOpts: Record<string, unknown> = {};
    if (argvWithoutJsonRpc.length > 0) {
      try {
        // Suppress stdout temporarily to prevent help from being printed
        const originalWrite = process.stdout.write.bind(process.stdout);
        let helpOutput = '';
        process.stdout.write = ((chunk: any, ...args: any[]) => {
          const str = chunk.toString();
          // Capture help output but don't print it
          if (str.includes('Usage:') || str.includes('Options:') || str.includes('Commands:')) {
            helpOutput += str;
            return true;
          }
          return originalWrite(chunk, ...args);
        }) as any;

        try {
          await program.parseAsync(['node', 'svr', ...argvWithoutJsonRpc]);
          parsedOpts = program.opts();
        } finally {
          // Restore stdout
          process.stdout.write = originalWrite;
        }
      } catch (err: any) {
        // Ignore parsing errors - we'll use default flags
        if (err?.code !== 'commander.help' && err?.code !== 'commander.helpDisplayed') {
          // Only log non-help errors
          console.error('Warning: Error parsing options for JSON-RPC mode:', err.message);
        }
      }
    }

    const flags = optsToFlags(parsedOpts);
    flags.jsonRpc = true;
    return await runJsonRpcMode(flags);
  }

  let parsedOpts: Record<string, unknown>;
  try {
    await program.parseAsync(['node', 'svr', ...argv]);
    parsedOpts = program.opts();

    // If a command set an exit code, return it
    if (commandExitCode !== null) {
      return commandExitCode;
    }

    // Check if a subcommand was executed by checking if argv[0] matches a known command
    const subcommands = ['test', 'update', 'snapshots', 'results', 'cleanup'];
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
      const availableCommands = ['test', 'update', 'snapshots', 'results', 'cleanup'];

      // Find similar commands
      const suggestions = availableCommands.filter((cmd) => {
        const distance = levenshteinDistance(unknownCmd.toLowerCase(), cmd.toLowerCase());
        return distance <= 2 && distance < cmd.length;
      });

      console.error(`\nUnknown command: ${unknownCmd}`);
      if (suggestions.length > 0) {
        console.error(`\nDid you mean one of these?`);
        suggestions.forEach((cmd) => console.error(`  ${cmd}`));
      } else {
        console.error(`\nAvailable commands: ${availableCommands.join(', ')}`);
      }
      const cmdName = getCommandName();
      console.error(`\nRun '${cmdName} --help' for more information.\n`);
      return EXIT_CODES.CONFIG_ERROR;
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
      return EXIT_CODES.CONFIG_ERROR;
    }

    if (err?.code === 'commander.excessArguments') {
      const cmdName = getCommandName();
      const excessArgs = err.args || [];
      console.error(
        `\nError: Unknown argument${excessArgs.length > 1 ? 's' : ''}: ${excessArgs.join(', ')}`,
      );
      console.error(`\nRun '${cmdName} --help' for more information.\n`);
      return EXIT_CODES.CONFIG_ERROR;
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
    const suggestions = subcommands.filter((cmd) => {
      const distance = levenshteinDistance(executedCommand.toLowerCase(), cmd.toLowerCase());
      return distance <= 2 && distance < cmd.length;
    });
    if (suggestions.length > 0) {
      console.error(`\nDid you mean one of these?`);
      suggestions.forEach((cmd) => console.error(`  ${cmd}`));
    } else {
      console.error(`\nAvailable commands: ${subcommands.join(', ')}`);
    }
    console.error(`\nRun 'svr --help' for more information.\n`);
    return EXIT_CODES.CONFIG_ERROR;
  }

  if (executedCommand && subcommands.includes(executedCommand)) {
    // A subcommand was executed - it should have handled everything and exited
    // If we reach here, return gracefully
    return 0;
  }

  // No command provided - the default action already showed help, so just return
  if (!executedCommand) {
    return 0;
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

    return EXIT_CODES.CONFIG_ERROR;
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
    // Read failed results from the results index
    try {
      const resultsDir = config.resolvePath(config.resultsPath);
      const resultsIndexManager = new ResultsIndexManager(resultsDir);
      const allEntries = resultsIndexManager.getAllEntries();

      // Filter to only failed results and convert to StoryResult format
      const failedResults = allEntries
        .filter((entry) => entry.status === 'failed')
        .map((entry) => {
          // Build paths for diff/actual images using getResultPath
          const diffPath = resultsIndexManager.getResultPath(
            entry.snapshotId,
            resultsDir,
            'diff',
            entry.storyId,
          );
          const actualPath = resultsIndexManager.getResultPath(
            entry.snapshotId,
            resultsDir,
            'actual',
            entry.storyId,
          );

          const diffExists = fs.existsSync(diffPath);
          const actualExists = fs.existsSync(actualPath);

          // Determine the actual failure reason based on available data
          let errorType:
            | 'screenshot_mismatch'
            | 'loading_failure'
            | 'network_error'
            | 'other_error'
            | undefined;
          let errorMessage: string | undefined;

          if (entry.status === 'failed') {
            // Check if we have diff comparison data (indicates screenshot was captured and compared)
            const hasComparisonData =
              entry.diffPixels !== undefined || entry.diffPercent !== undefined;

            if (hasComparisonData) {
              // Screenshot was captured and compared - this is a screenshot mismatch
              errorType = 'screenshot_mismatch';
              if (!diffExists) {
                // Diff file is missing even though comparison happened
                errorMessage = `Screenshot mismatch (${entry.diffPixels || 0} pixels, ${(entry.diffPercent || 0).toFixed(2)}%) - diff image missing`;
              } else {
                errorMessage = `Screenshot mismatch (${entry.diffPixels || 0} pixels, ${(entry.diffPercent || 0).toFixed(2)}%)`;
              }
            } else if (actualExists) {
              // Actual image exists but no comparison data - might be a comparison failure
              errorType = 'screenshot_mismatch';
              errorMessage = 'Screenshot mismatch (comparison data unavailable)';
            } else if (!entry.snapshotId) {
              // No snapshot ID means no baseline exists
              errorType = 'other_error';
              errorMessage = 'Missing baseline snapshot';
            } else {
              // No actual image and has snapshot ID - likely a loading failure
              errorType = 'loading_failure';
              errorMessage = 'Failed to capture screenshot';
            }

            // Log if diff is missing for debugging
            if (!diffExists && hasComparisonData) {
              logger.debug(
                `Missing diff image for ${entry.storyId}: expected at ${diffPath}, actual exists: ${actualExists}`,
              );
            }
          }

          return {
            storyId: entry.storyId,
            storyName: entry.storyId, // We don't have storyName in the index, use storyId
            status: entry.status as 'passed' | 'failed' | 'skipped' | 'timedOut',
            duration: entry.duration,
            diffPath: diffExists ? diffPath : undefined,
            actualPath: actualExists ? actualPath : undefined,
            expectedPath: undefined, // Expected path would be in snapshots, not results
            errorPath: entry.status === 'failed' && actualExists ? actualPath : undefined,
            errorType,
            error: errorMessage,
            diffPixels: entry.diffPixels,
            diffPercent: entry.diffPercent,
          };
        });

      return failedResults;
    } catch (error) {
      logger.error(`Failed to load results: ${error}`);
      return [];
    }
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
