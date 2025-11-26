#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { resolveConfig, saveEffectiveConfig, type CliFlags } from '../config.js';
import { Command } from '@commander-js/extra-typings';
import { run } from '../core/VisualRegressionRunner.js';
import { setGlobalLogger, logger } from '../logger.js';
import { listSnapshots } from '../core/ListSnapshots.js';
import { listResults } from '../core/ListResults.js';
import { getCommandName } from '../utils/commandName.js';
import { EXIT_CODES } from '../parallel-runner.js';
import { levenshteinDistance } from '../utils/string-distance.js';
import {
  createMainProgram,
  createTestCommand,
  createUpdateCommand,
  createSnapshotsCommand,
  createResultsCommand,
  createCleanupCommand,
} from './commands.js';
import { runJsonRpcMode } from './json-rpc-handler.js';

/**
 * Helper to convert Commander.js opts to CliFlags format
 */
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
  const program = createMainProgram();

  // Store exit code for commands that execute
  let commandExitCode: number | null = null;

  // Create and add all commands with their action handlers
  const testCmd = createTestCommand().action(async (opts: Record<string, unknown>) => {
    try {
      const flags = optsToFlags(opts);
      const config = resolveConfig(flags);
      setGlobalLogger(config.logLevel);
      const code = await run(config);
      commandExitCode = code;

      // Show report if requested
      if (opts.results || opts.resultsFile !== undefined) {
        const status = opts.all ? undefined : opts.status || 'failed';

        let outputFile: string | undefined;
        if (opts.resultsFile !== undefined) {
          if (opts.resultsFile === true || opts.resultsFile === '') {
            outputFile = path.join(config.resolvePath(config.resultsPath), 'report.txt');
          } else {
            const outputPath = String(opts.resultsFile);
            const resolvedPath = path.isAbsolute(outputPath)
              ? outputPath
              : path.resolve(process.cwd(), outputPath);
            if (
              !path.extname(resolvedPath) ||
              (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory())
            ) {
              outputFile = path.join(resolvedPath, 'report.txt');
            } else {
              outputFile = resolvedPath;
            }
          }
          if (outputFile && !path.isAbsolute(outputFile)) {
            outputFile = path.resolve(process.cwd(), outputFile);
          }
        }

        listResults(config, {
          status: status as any,
          include: config.includeStories,
          exclude: config.excludeStories,
          grep: config.grep,
          outputFile,
        });
      }
    } catch (err) {
      logger.error(
        `Error in test command: ${err instanceof Error ? err.message : String(err)}`,
      );
      commandExitCode = 1;
    }
  });

  const updateCmd = createUpdateCommand().action(async (opts: Record<string, unknown>) => {
    try {
      const flags = optsToFlags(opts);
      flags.update = true;
      const config = resolveConfig(flags);
      setGlobalLogger(config.logLevel);
      const code = await run(config);
      commandExitCode = code;
    } catch (err) {
      logger.error(
        `Error in update command: ${err instanceof Error ? err.message : String(err)}`,
      );
      commandExitCode = 1;
    }
  });

  const snapshotsCmd = createSnapshotsCommand().action(async (opts: Record<string, unknown>) => {
    const flags = optsToFlags(opts);
    const config = resolveConfig(flags);
    setGlobalLogger(config.logLevel);
    listSnapshots(config, {
      include: config.includeStories,
      exclude: config.excludeStories,
      grep: config.grep,
    });
    commandExitCode = 0;
  });

  const resultsCmd = createResultsCommand().action(async (opts: Record<string, unknown>) => {
    const flags = optsToFlags(opts);
    const config = resolveConfig(flags);
    setGlobalLogger(config.logLevel);

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
      outputFile,
    });
    commandExitCode = 0;
  });

  const cleanupCmd = createCleanupCommand().action(async (opts: Record<string, unknown>) => {
    const { SnapshotIndexManager } = await import('../core/SnapshotIndex.js');
    const { ResultsIndexManager } = await import('../core/ResultsIndex.js');

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
          console.log(
            `Cleaned up ${duplicateCleanup.deletedEntries} duplicate result entr${duplicateCleanup.deletedEntries === 1 ? 'y' : 'ies'}`,
          );
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
  });

  // Add all commands to the program
  program.addCommand(testCmd).addCommand(updateCmd).addCommand(snapshotsCmd).addCommand(resultsCmd).addCommand(cleanupCmd);

  // Default action: if no subcommand provided, show help
  program
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
    });

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

// Main function wrapper that uses process.argv
const main = async (): Promise<number> => {
  return mainWithArgv(process.argv.slice(2));
};

// Main function now handles its own errors and exits
main().then((code) => process.exit(code));
