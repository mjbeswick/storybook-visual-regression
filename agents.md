# Agents Guide for Storybook Visual Regression

This document provides essential information for AI agents working with this codebase.

## Project Overview

This is a **monorepo** containing two main packages:

1. **`cli/`** - `@storybook-visual-regression/cli` - Command-line tool for visual regression testing
2. **`addon/`** - `@storybook-visual-regression/addon` - Storybook addon with integrated UI

The project uses **npm workspaces** and requires **Node.js >= 20.0.0**.

## Architecture

### Communication Flow

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Manager   │         │    Preset    │         │   Preview   │
│   (Panel)   │◄───────►│  (Node.js)   │◄───────►│  (Browser)  │
│             │  HTTP   │              │  SSE    │             │
└─────────────┘         └──────┬───────┘         └─────────────┘
                                │
                                │ JSON-RPC over stdio
                                ▼
                         ┌─────────────┐
                         │     CLI      │
                         │  (Process)   │
                         └─────────────┘
```

### Key Communication Patterns

1. **Manager ↔ Preview**: Storybook channel (may not bridge reliably, so HTTP/SSE is used as fallback)
2. **Manager ↔ Preset**: HTTP POST to `/emit-event` endpoint
3. **Preset ↔ Preview**: Server-Sent Events (SSE) via `/events` endpoint
4. **Preset ↔ CLI**: JSON-RPC over stdio (via `JsonRpcBridge`)
5. **Preview ↔ Preset**: HTTP POST to `/rpc` endpoint (proxied to CLI)

## Important Files

### CLI Package (`cli/src/`)

- **`cli/index.ts`** - Main CLI entry point, command definitions, JSON-RPC server setup
- **`jsonrpc.ts`** - JSON-RPC client/server implementation for stdio communication
- **`core/VisualRegressionRunner.ts`** - Orchestrates test runs, story discovery, parallel execution
- **`core/ResultsIndex.ts`** - Manages `results/index.jsonl` file (JSONL format for git-friendliness)
- **`core/SnapshotIndex.ts`** - Manages `snapshots/index.jsonl` file
- **`parallel-runner.ts`** - Worker pool for parallel test execution, progress tracking
- **`config.ts`** - Configuration resolution and validation

### Addon Package (`addon/src/`)

- **`preset.ts`** - Node.js preset, starts HTTP server and `JsonRpcBridge`, handles RPC proxying
- **`preview.ts`** - Browser-side preview code, listens for Storybook events, communicates with preset via HTTP
- **`Panel.tsx`** - Main addon panel UI component (manager-side)
- **`TestResultsContext.tsx`** - React context for managing test results state
- **`JsonRpcBridge.ts`** - Bridges Storybook channel events to CLI JSON-RPC over stdio
- **`constants.ts`** - Event name constants
- **`types.ts`** - TypeScript type definitions

## Key Concepts

### Index Files (JSONL Format)

Both `snapshots/index.jsonl` and `results/index.jsonl` use **JSONL (JSON Lines)** format:

- One JSON object per line
- Git-friendly (line-based diffs)
- Efficient for append-only operations
- Entries are unique by: `storyId + browser + viewportName`

**Important**: Never add migration logic to the codebase. Use separate migration scripts in `scripts/`.

### Event System

Events flow in multiple directions:

1. **Manager → Preview**: Via HTTP POST to `/emit-event`, then forwarded via SSE
2. **Preview → Manager**: Via HTTP POST to `/emit-event`, then forwarded via SSE
3. **Preview → Preset**: Via HTTP POST to `/rpc` (proxied to CLI)
4. **CLI → Preset**: Via JSON-RPC notifications over stdio
5. **Preset → Preview**: Via SSE (`/events` endpoint)

**Key Events:**

- `RUN_TEST` - Test current story
- `RUN_ALL_TESTS` - Test all stories
- `UPDATE_BASELINE` - Update snapshot for current story
- `TEST_STARTED` - Test run started
- `UPDATE_STARTED` - Snapshot update started
- `TEST_COMPLETE` - Test run completed
- `PROGRESS` - Progress update with stats
- `TEST_RESULT` - Individual test result

### Progress Information

Progress events include:

- `completed` / `total` - Story counts
- `passed` / `failed` / `skipped` - Result counts
- `percent` - Completion percentage
- `storiesPerMinute` - Throughput
- `timeRemaining` / `timeRemainingFormatted` - ETA
- `workers` - Number of concurrent workers
- `cpuUsage` - CPU usage percentage
- `elapsed` - Elapsed time in seconds

### State Management

- **`isRunning`**: Test is running (shows progress bar)
- **`isUpdating`**: Snapshot update is running (shows "Updating snapshot..." message)
- **`progress`**: Current progress info (null when not running)
- **`results`**: Array of test results

## Common Patterns

### Adding a New Event

1. Add event name to `addon/src/constants.ts`
2. Add handler in `addon/src/preview.ts` (if preview should handle it)
3. Add handler in `addon/src/TestResultsContext.tsx` (if manager should handle it)
4. Emit from appropriate location (Panel, preview, or CLI)

### Modifying CLI Commands

1. Edit `cli/src/cli/index.ts` for command definitions
2. Use `resolveConfig()` to get configuration
3. Call `run()` from `VisualRegressionRunner` for test execution
4. Use `JsonRpcServer` for JSON-RPC mode

### Modifying Addon UI

1. Edit `addon/src/Panel.tsx` for main UI
2. Use `useTestResults()` hook for state
3. Emit events via `channel.emit()` or HTTP POST to `/emit-event`
4. Update `addon/src/Panel.module.css` for styles

### Index File Operations

- **Reading**: Use `getAllEntries()` method
- **Writing**: Use `updateEntry()` method (debounced, flushed on signal handlers)
- **Cleanup**: Use `cleanupDuplicateEntries()` and `cleanupOrphanedFiles()`
- **Uniqueness**: Entries are unique by `storyId + browser + viewportName`

## Important Technical Details

### JSON-RPC Mode

When `--json-rpc` flag is present:

- CLI enters JSON-RPC mode (no help output)
- Reads from stdin, writes to stdout
- Uses `JsonRpcServer` for handling requests
- Always add `--json-rpc` when spawning CLI from addon

### Signal Handling

Both `SnapshotIndex` and `ResultsIndex` have signal handlers (`SIGINT`, `SIGTERM`) to flush pending writes before exit.

### File Paths

- Snapshots: `{snapshotPath}/{snapshotId}/{storyId}.png`
- Results: `{resultsPath}/{snapshotId}/{type}/{storyId}.png` (where type is 'diff', 'actual', or 'expected')
- Index files: `{path}/index.jsonl`

### Story ID Format

Story IDs may include viewport suffixes: `--unattended`, `--attended`, `--customer`, `--mobile`, `--tablet`, `--desktop`

When navigating, remove these suffixes to get the base story ID.

### Error Handling

- CLI errors are logged and returned as JSON-RPC errors
- Addon errors are logged to console and shown in UI
- Network errors are caught and displayed to user
- Always emit `TEST_COMPLETE` even on error

## Development Workflow

### Building

```bash
npm run build              # Build all packages
npm run build --workspace cli    # Build CLI only
npm run build --workspace addon  # Build addon only
```

### Testing

```bash
npm run test              # Run tests in all packages
```

### Code Style

- Use TypeScript (strict mode)
- Prefer `type` over `interface` (per user rules)
- Use async/await for async operations
- Add logging for debugging (use `console.log` with `[VR Addon]` or `[VR CLI]` prefix)

## Common Issues and Solutions

### Events Not Received

- Check if EventSource is connected (look for "EventSource connected" log)
- Verify HTTP server is running on port 6007
- Check if event is being sent via HTTP (`/emit-event` endpoint)
- Ensure handlers are registered in both preview and manager

### Progress Not Showing

- Verify `TEST_STARTED` or `UPDATE_STARTED` is emitted
- Check if `TestResultsContext` receives the event
- Verify `isRunning` or `isUpdating` state is set
- Check if progress info is being sent from CLI

### Buttons Not Working

- Verify channel is available (`isChannelReady`)
- Check if events are being emitted (look for console logs)
- Ensure HTTP fallback is working (events sent via `/emit-event`)
- Verify preview is receiving events via EventSource

### Index File Issues

- Never modify index files directly - use index managers
- Entries must be unique by `storyId + browser + viewportName`
- Use migration scripts for format changes (don't add migration to code)
- Flush writes before exit (signal handlers handle this)

## File Locations Reference

### Configuration

- CLI config: `cli/src/config.ts`, `cli/src/config/defaultConfig.ts`
- Addon config: `addon/src/config.ts`

### Core Logic

- Test execution: `cli/src/core/VisualRegressionRunner.ts`
- Parallel execution: `cli/src/parallel-runner.ts`
- Index management: `cli/src/core/ResultsIndex.ts`, `cli/src/core/SnapshotIndex.ts`

### Addon Components

- Panel UI: `addon/src/Panel.tsx`
- State management: `addon/src/TestResultsContext.tsx`
- Communication: `addon/src/preset.ts`, `addon/src/preview.ts`, `addon/src/JsonRpcBridge.ts`

### Types

- CLI types: `cli/src/jsonrpc.ts` (StoryResult, ProgressInfo, etc.)
- Addon types: `addon/src/types.ts` (TestResult, ProgressInfo, etc.)

## Best Practices

1. **Always use index managers** for reading/writing index files
2. **Use HTTP/SSE for manager-preview communication** (channel may not bridge)
3. **Add logging** for debugging event flow
4. **Handle errors gracefully** and emit completion events
5. **Don't add migration logic** - use separate scripts
6. **Test both manager and preview** contexts when making changes
7. **Verify EventSource connections** when debugging communication issues
8. **Use debounced writes** for index files (already implemented)
9. **Flush writes on exit** (signal handlers handle this)
10. **Keep index entries unique** by full key (storyId + browser + viewportName)
