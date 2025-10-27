# Agent Memory - Storybook Visual Regression Tool

## Application Overview

This is a CLI tool for running visual regression tests on Storybook stories using Playwright. The tool discovers all stories from a running Storybook instance, takes screenshots of each story, and compares them against baseline snapshots to detect visual changes.

### How It Works

1. **Story Discovery**: The tool connects to a running Storybook server and fetches the story index (`/index.json`) to discover all available stories
2. **Story Filtering**: Stories can be filtered using `--include`, `--exclude`, and `--grep` patterns
3. **Screenshot Capture**: For each story, the tool navigates to the story URL and takes a screenshot
4. **Visual Comparison**: Screenshots are compared against baseline snapshots stored in `visual-regression/snapshots/`
5. **Update Mode**: The `update` command creates new baseline snapshots when they don't exist or when visual changes are intentional

### Key Components

- **CLI (`src/cli/index.ts`)**: Main entry point that parses commands and options
- **Config (`src/config.ts`)**: Playwright configuration factory that creates test configs
- **Test Runner (`src/tests/storybook.spec.ts`)**: Playwright test that discovers stories and takes screenshots
- **Story Discovery (`src/core/StorybookDiscovery.ts`)**: Logic for fetching and filtering stories from Storybook
- **Visual Regression Runner (`src/core/VisualRegressionRunner.ts`)**: Orchestrates the test execution

## Key Architectural Decisions

### 1. Use Playwright's webServer Configuration

**CRITICAL**: Always use Playwright's built-in `webServer` configuration to manage Storybook lifecycle, not manual server management.

- ✓ **Correct**: Use `webServer` in Playwright config to start/stop Storybook
- ✘ **Wrong**: Manually spawn Storybook processes and manage lifecycle
- ✘ **Wrong**: Try to connect to already-running Storybook instances

**Why**: Playwright's webServer handles:

- Server startup timing
- Health checks
- Process cleanup
- Port conflicts
- Error handling

### 2. Port Detection Pattern

Always extract port from storybook command when possible:

```typescript
const portMatch = options.command.match(/-p\s+(\d+)|--port\s+(\d+)/);
if (portMatch) {
  detectedPort = portMatch[1] || portMatch[2];
}
```

### 3. CLI Architecture

The CLI has two main paths:

1. **Direct CLI path**: Uses `VisualRegressionRunner` + `StorybookDiscovery`
2. **Playwright reporter path**: Uses `runWithPlaywrightReporter()` with full Playwright config

**Always prefer the Playwright reporter path** as it handles webServer properly.

### 3.1. NO Environment Variables Rule

**CRITICAL**: This application MUST NOT use environment variables for configuration or communication between components.

- ✓ **Correct**: Pass all options directly through function parameters and configuration objects
- ✓ **Correct**: Use `createPlaywrightConfig(userConfig, updateMode)` with explicit parameters
- ✓ **Correct**: Pass filtering options (`include`, `exclude`, `grep`) directly to test functions
- ✘ **Wrong**: Use ANY environment variables (`process.env.*`)
- ✘ **Wrong**: Use `process.env.PLAYWRIGHT_*` variables
- ✘ **Wrong**: Use `process.env.STORYBOOK_*` variables
- ✘ **Wrong**: Use `process.env.SVR_*` variables
- ✘ **Wrong**: Use `process.env.NODE_ENV` for application logic

**Why**:

- Direct parameter passing is more maintainable and type-safe
- Eliminates hidden dependencies and side effects
- Makes the code more testable and predictable
- Prevents configuration drift and environment-specific bugs

### 3.2. Configuration Architecture

**CRITICAL**: All configuration must flow through explicit function parameters and typed interfaces.

- ✓ **Correct**: `createPlaywrightConfig(userConfig: VisualRegressionConfig, updateMode: boolean)`
- ✓ **Correct**: Pass CLI options directly to test functions as parameters
- ✓ **Correct**: Use TypeScript interfaces for all configuration objects
- ✘ **Wrong**: Rely on environment variables for any configuration
- ✘ **Wrong**: Use global variables or singletons for configuration

### 4. Update Mode Implementation

**CRITICAL**: Update mode must be implemented without environment variables.

- ✓ **Correct**: Pass `updateMode: boolean` parameter to `createPlaywrightConfig(userConfig, updateMode)`
- ✓ **Correct**: Set `updateSnapshots: updateMode ? 'all' : 'none'` in Playwright config
- ✓ **Correct**: Use Playwright's built-in snapshot creation when `updateSnapshots: 'all'`
- ✘ **Wrong**: Use environment variables to detect update mode
- ✘ **Wrong**: Manually handle snapshot creation in test code
- ✘ **Wrong**: Use custom logic to bypass Playwright's snapshot handling

**Why**: Playwright's built-in update mode handles all edge cases and provides consistent behavior.

### 5. Test Execution Flow

**CRITICAL**: Tests must discover stories dynamically and handle filtering without environment variables.

- ✓ **Correct**: Fetch stories from Storybook's `/index.json` endpoint
- ✓ **Correct**: Apply filtering logic (`include`, `exclude`, `grep`) in test code
- ✓ **Correct**: Use `toHaveScreenshot()` with proper naming convention
- ✘ **Wrong**: Pre-generate test files for each story
- ✘ **Wrong**: Use environment variables for story filtering
- ✘ **Wrong**: Hardcode story lists or use static configuration

### 6. Error Handling Patterns

- Use `reuseExistingServer: true` in webServer config
- Provide clear troubleshooting steps in error messages
- Include port detection in error diagnostics
- Always clean up processes in finally blocks
- Handle missing snapshots gracefully in update mode

### 6.1. Test Timeout Architecture

**CRITICAL**: The Playwright test timeout must be calculated dynamically based on all possible wait operations to prevent "Test timeout exceeded while setting up 'page'" errors.

- ✓ **Correct**: Calculate `testTimeout` as sum of all wait timeouts plus buffer with safety multiplier:

  ```typescript
  const calculatedTimeout =
    navTimeout +
    waitTimeout +
    overlayTimeout +
    stabilizeInterval * stabilizeAttempts +
    finalSettle +
    10000 + // Additional waits in waitForLoadingSpinners
    5000 + // Additional checks (error page, content visibility)
    20000; // Buffer for screenshot capture and other operations

  // Apply 1.5x safety multiplier for edge cases
  const testTimeout = Math.max(Math.ceil(calculatedTimeout * 1.5), 60000);
  ```

- ✓ **Correct**: Set minimum test timeout of 60 seconds
- ✓ **Correct**: Apply test timeout to Playwright config: `timeout: testTimeout`
- ✓ **Correct**: Add debug logging to track operation timing
- ✓ **Correct**: Handle screenshot buffer errors gracefully with clear error messages
- ✘ **Wrong**: Use fixed test timeout (like 30000ms default)
- ✘ **Wrong**: Set test timeout lower than the sum of all wait operations

**Why**:

- Individual operations (navigation, waiting for elements, stabilization) have their own timeouts
- The test timeout must be **longer** than the sum of all possible waits
- Otherwise, the test will timeout before operations can complete, causing cryptic errors
- Buffer time accounts for screenshot capture and other overhead

**Error Prevention**:

- Check for closed pages before taking screenshots: `if (page.isClosed())`
- Detect buffer errors: `errorMessage.includes('The "data" argument must be of type string')`
- Provide clear error messages when page is in invalid state

### 7. File Structure

- `src/cli/index.ts` - Main CLI entry point
- `src/core/VisualRegressionRunner.ts` - Test execution logic
- `src/core/StorybookDiscovery.ts` - Story discovery (assumes server running)
- `src/config.ts` - Playwright configuration factory (`createPlaywrightConfig`)
- `src/config/defaultConfig.ts` - Default configuration
- `src/types/index.ts` - TypeScript definitions

### 7.1. Output Directory Structure

**CRITICAL**: The CLI should only create one directory: `visual-regression` in the directory where the CLI is executed.

**Expected Structure**:

```
visual-regression/
├── snapshots/           # Baseline snapshot images organized by story hierarchy
│   ├── ComponentName/
│   │   ├── Story Name 1.png
│   │   └── Story Name 2.png
│   └── Screens/
│       └── Colleague/
│           └── SSC Cash/
│               └── Cash Management/
│                   ├── Dashboard.png
│                   └── Dashboard With Scroll.png
└── results/            # Playwright test results
    ├── test-results/
    ├── reports/
    └── ...
```

**Snapshot Organization**:

Snapshots are organized in a hierarchical folder structure that mirrors the Storybook story organization:

- **Story Title**: Used as the folder path (e.g., `Screens / Colleague / SSC Cash / Cash Management` becomes `Screens/Colleague/SSC Cash/Cash Management/`)
- **Story Name**: Used as the filename (e.g., `Dashboard` becomes `Dashboard.png`)
- **Result**: `Screens/Colleague/SSC Cash/Cash Management/Dashboard.png`

This organization makes it easy to:

- Find snapshots that correspond to specific stories
- Organize snapshots by feature or component area
- Navigate the snapshot directory structure

**Results Organization**:

Test results (diff images, expected images) are automatically organized using the same hierarchical structure:

- When a test fails, Playwright creates a test result directory
- Inside that directory, diff and expected images use the same folder hierarchy as snapshots
- Example: `visual-regression/results/{test-result-folder}/Screens/Colleague/SSC Cash/Cash Management/Dashboard-diff.png`
- This makes it easy to correlate failures with their corresponding snapshots

**Directory Behavior**:

- ✓ **Correct**: Create `visual-regression/` in the current working directory where CLI is executed
- ✓ **Correct**: Use `-o` flag to specify custom output directory: `-o "test/visual-regression"`
- ✘ **Wrong**: Create `.svr-playwright/` or any other configuration directories
- ✘ **Wrong**: Create output directories in the main project directory when run from subdirectories

**Why**: This keeps the tool clean and predictable - users know exactly where their visual regression data will be stored.

### 8. Build and Publish Process

- Always run `npm run build` before publishing
- Use `npm version patch/minor/major` for versioning
- Push tags with `git push --tags`
- **NEVER publish automatically - wait for user to explicitly ask for publishing**
- Only commit and push changes, do not run `npm publish` unless requested
- **NEVER commit code until you have tested that it works**
- Test changes locally before committing to ensure functionality

### 9. Common Issues and Solutions

#### Test Timeout Errors

- **Cause**: Test timeout (default 30s) is shorter than the sum of all wait operations
- **Solution**: The tool now auto-calculates test timeout based on all timeouts + buffer (minimum 60s with 1.5x safety multiplier)

#### Stories That Load Instantly in Browser But Timeout in Tests

- **Cause**: `waitUntil: 'load'` waits for ALL resources to finish, but some font/asset requests may hang or timeout, even though the page visually loads instantly
- **Solution**: Tool automatically falls back to `networkidle` if `load` times out, then explicitly waits for fonts
- **Result**: Tests won't hang on stuck resources, but fonts still load properly for consistent screenshots
- **Alternative**: Use `--wait-until networkidle` from the start for faster tests

#### Storybook Preparing Overlays Not Hiding

- **Cause**: Storybook's `.sb-preparing-story` and `.sb-preparing-docs` overlays sometimes stay visible
- **Solution**: Tool now immediately force-hides these overlays instead of waiting for them

#### Buffer/Screenshot Errors (TypeError: The "data" argument...)

- **Cause**: Page is in invalid state when screenshot is attempted (usually after timeout)
- **Solution**: Tool now checks page state and provides clear error messages

#### ECONNREFUSED Error

- **Cause**: Trying to connect to Storybook before it's ready
- **Solution**: Use Playwright webServer, not manual connection attempts

#### Port Mismatch

- **Cause**: Tool expects different port than Storybook runs on
- **Solution**: Extract port from storybook command or use `-p` flag

#### Server Timeout

- **Cause**: Storybook takes longer than expected to start
- **Solution**: Increase `serverTimeout` in config, use webServer health checks

### 10. Testing Commands

```bash
# Basic test
storybook-visual-regression test -c "npm run dev:ui"

# With specific port
storybook-visual-regression test -c "npm run dev:ui" -p 6006

# Update snapshots
storybook-visual-regression update -c "npm run dev:ui"

# With custom timeouts for slow stories
storybook-visual-regression update \
  --wait-timeout 30000 \
  --nav-timeout 10000 \
  --stabilize-attempts 30 \
  -c "npm run dev:ui"

# Adjust resource settle time for faster/slower resource loading
storybook-visual-regression test \
  --resource-settle 200 \
  -c "npm run dev:ui"
```

### 11. Development Workflow

1. Make changes to TypeScript files
2. Run `npm run build` to compile
3. Test locally with `npm link` or direct execution
4. Commit changes with descriptive messages
5. Version bump and publish

### 12. Code Quality and ESLint Practices

**CRITICAL**: Maintain strict TypeScript typing and ESLint compliance throughout the codebase.

#### 12.1. Regex Pattern Escaping

- ✓ **Correct**: Properly escape regex patterns in template literals:
  ```typescript
  // In template literals, escape backslashes
  new RegExp(`(\\s|^)${flag}(\\s|=)`)
  /(\\s|^)(-p|--port)(\\s|=)/
  ```
- ✘ **Wrong**: Unescaped patterns that trigger `no-useless-escape` warnings:
  ```typescript
  // This triggers ESLint error
  new RegExp(`(\s|^)${flag}(\s|=)`)
  /(\s|^)(-p|--port)(\s|=)/
  ```

**Why**: Template literals require double escaping (`\\s`) while regex literals require single escaping (`\s`).

#### 12.2. Type Safety Practices

- ✓ **Correct**: Use proper type assertions with specific interfaces:
  ```typescript
  saveUserConfig(cwd, config as VisualRegressionConfig);
  ```
- ✘ **Wrong**: Unsafe `any` type usage:
  ```typescript
  saveUserConfig(cwd, config as any);
  saveUserConfig(cwd, config as unknown as any);
  ```

**Why**:

- Prevents runtime type errors
- Enables better IDE support and autocomplete
- Makes refactoring safer
- Follows TypeScript best practices

#### 12.3. ESLint Rule Compliance

**Critical Rules to Follow**:

- `@typescript-eslint/no-explicit-any`: Never use `any` type
- `@typescript-eslint/no-unsafe-argument`: Don't pass `any` to typed parameters
- `no-useless-escape`: Properly escape regex patterns
- `@typescript-eslint/prefer-types`: Use `type` over `interface` when possible

**Common Patterns**:

```typescript
// ✅ Good: Proper type assertion
const config: VisualRegressionConfig = userConfig as VisualRegressionConfig;

// ✅ Good: Proper regex escaping in template literals
const pattern = new RegExp(`(\\s|^)${flag}(\\s|=)`);

// ✅ Good: Using type instead of interface
type CliOptions = {
  config?: string;
  port?: string;
  // ...
};

// ❌ Bad: Unsafe any usage
const config = userConfig as any;

// ❌ Bad: Unescaped regex in template literal
const pattern = new RegExp(`(\s|^)${flag}(\s|=)`);
```

#### 12.4. Code Quality Workflow

1. **Before committing**: Run `npm run lint` to check for ESLint errors
2. **Fix all errors**: Never commit code with ESLint violations
3. **Type safety**: Ensure all type assertions use proper interfaces
4. **Regex patterns**: Double-check escaping in template literals
5. **Test locally**: Verify changes work before committing

### 13. Addon Architecture

The project includes a Storybook addon (`addon/`) that provides a UI for running visual regression tests directly from Storybook.

#### 13.1. Addon Components

- **Manager (`addon/src/manager.tsx`)**: Main addon registration and provider setup
- **Panel (`addon/src/Panel.tsx`)**: Main UI component for running tests and viewing results
- **Tool (`addon/src/Tool.tsx`)**: Toolbar buttons for showing diff images in the preview iframe
- **Preview (`addon/src/preview.ts`)**: Browser-side code that communicates with the API server
- **Server (`addon/src/server.ts`)**: Node.js API server that spawns CLI processes
- **Types (`addon/src/types.ts`)**: TypeScript type definitions for the addon

#### 13.2. Addon Communication Flow

1. **Manager → Preview**: Uses Storybook's channel system to emit events
2. **Preview → Server**: Makes HTTP requests to localhost:6007 API server
3. **Server → CLI**: Spawns `storybook-visual-regression` CLI processes
4. **CLI → Server**: Streams JSON output via stdout
5. **Server → Preview**: Streams results via Server-Sent Events (SSE)
6. **Preview → Manager**: Emits test results back through Storybook channel

#### 13.3. Addon TypeScript Best Practices

**CRITICAL**: Follow these patterns for proper TypeScript usage in the addon:

- ✓ **Correct**: Define explicit types for all data structures
- ✓ **Correct**: Use proper channel typing with explicit interfaces
- ✓ **Correct**: Handle undefined values with proper fallbacks
- ✓ **Correct**: Remove unused variables and imports
- ✓ **Correct**: Use empty catch blocks with comments when errors should be ignored
- ✘ **Wrong**: Use `any` type - always define proper types
- ✘ **Wrong**: Leave unused variables or imports
- ✘ **Wrong**: Use empty catch blocks without comments

**Channel Typing Pattern**:

```typescript
type Channel = {
  emit: (event: string, data?: unknown) => void;
  on: (event: string, callback: (data?: unknown) => void) => void;
  off: (event: string, callback: (data?: unknown) => void) => void;
};

const getChannel = (): Channel | null => {
  if (
    typeof window !== 'undefined' &&
    (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: Channel }).__STORYBOOK_ADDONS_CHANNEL__
  ) {
    return (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__: Channel })
      .__STORYBOOK_ADDONS_CHANNEL__;
  }
  return null;
};
```

**Error Handling Pattern**:

```typescript
// For non-fatal errors that should be ignored
} catch {
  // ignore malformed messages
}

// For operations that might fail but shouldn't break the flow
try {
  watcher.close();
} catch {
  // ignore close errors
}
```

**Undefined Value Handling**:

```typescript
// Always provide fallbacks for potentially undefined values
const storyName = title || sid || 'Unknown Story';
```

#### 13.4. Addon File Structure

```
addon/
├── src/
│   ├── manager.tsx          # Addon registration and provider
│   ├── Panel.tsx           # Main UI panel component
│   ├── Panel.module.css    # Panel-specific styles
│   ├── Tool.tsx            # Toolbar buttons component
│   ├── Tool.module.css     # Tool-specific styles
│   ├── StoryHighlighter.tsx # Story highlighting component
│   ├── StoryHighlighter.module.css # Highlighting styles
│   ├── TestResultsContext.tsx # React context for test results
│   ├── preview.ts          # Browser-side preview code
│   ├── server.ts           # Node.js API server
│   ├── constants.ts        # Event constants
│   ├── types.ts           # TypeScript type definitions
│   └── types/
│       └── css.d.ts       # CSS module type declarations
├── dist/                   # Compiled addon output
├── package.json           # Addon package configuration
└── README.md             # Addon documentation
```

#### 13.5. Addon Development Workflow

1. Make changes to TypeScript files in `addon/src/`
2. Run `npm run build` in the addon directory to compile
3. Test the addon in a Storybook instance
4. The addon automatically reloads when files change
5. Use `npm link` to test the addon in other projects

#### 13.6. Addon ESLint Configuration

The addon uses strict ESLint rules:

- `@typescript-eslint/no-explicit-any`: Prevents use of `any` type
- `@typescript-eslint/no-unused-vars`: Prevents unused variables
- `no-empty`: Prevents empty block statements without comments

**Common ESLint Fixes**:

- Replace `any` with proper type definitions
- Remove unused variables and imports
- Add comments to empty catch blocks
- Use proper fallbacks for undefined values

### 14. Dependencies

- **Core**: `@playwright/test`, `commander`, `chalk`, `ora`
- **Dev**: `typescript`, `eslint`, `prettier`, `vitest`
- **Peer**: `@playwright/test` (user must install)

## Remember

- **WebServer first**: Always use Playwright's webServer for server management
- **Port detection**: Extract ports from commands when possible
- **Error context**: Provide helpful troubleshooting steps
- **Cleanup**: Always clean up processes and temp files
- **Playwright reporter**: Prefer the Playwright reporter path over direct CLI
- **Direct configuration**: Pass all options through configuration objects, not environment variables
- **Type safety**: Never use `any` type - always use proper TypeScript interfaces
- **Regex escaping**: Double-escape backslashes in template literals (`\\s` not `\s`)
- **ESLint compliance**: Fix all linting errors before committing code
- **Git hygiene**: Always update .gitignore when adding new generated files or directories
- **Documentation**: Update README.md when making significant changes to functionality or usage

## Recent Learnings and Updates

### Configuration Management System

**CRITICAL**: The CLI now uses a sophisticated configuration management system that prioritizes user convenience and persistence.

#### Configuration File Discovery

The CLI searches for configuration files in this order:

1. `visual-regression/config.json` (default, preferred)
2. `svr.config.js`
3. `svr.config.ts`
4. `svr.config.mjs`
5. `svr.config.cjs`
6. `.svrrc.json`
7. `.svrrc.js`
8. `.svrrc`

#### Configuration Merging Logic

**Priority Order** (highest to lowest):

1. CLI command-line options
2. User configuration file (`visual-regression/config.json`)
3. Detected Storybook configuration
4. Default configuration

#### Configuration Persistence

- ✓ **Correct**: CLI options override config file values
- ✓ **Correct**: Overridden values are persisted back to `config.json`
- ✓ **Correct**: Only non-default values are written to config file (prevents bloat)
- ✓ **Correct**: Config file is created automatically if it doesn't exist
- ✘ **Wrong**: Override config without persisting changes
- ✘ **Wrong**: Write default values to config file

#### New Configuration Options

```typescript
type UserConfig = {
  // ... existing options ...
  fullPage?: boolean; // New option for full-page screenshots
  // ... other options ...
};
```

### Storybook Addon Development Patterns

#### Channel Type Safety

**CRITICAL**: Always properly type Storybook addon channels to avoid TypeScript errors:

```typescript
type Channel = {
  emit: (event: string, data?: unknown) => void;
  on: (event: string, callback: (data?: unknown) => void) => void;
  off: (event: string, callback: (data?: unknown) => void) => void;
};

const getChannel = () => {
  if (
    typeof window !== 'undefined' &&
    (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: Channel }).__STORYBOOK_ADDONS_CHANNEL__
  ) {
    return (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__: Channel })
      .__STORYBOOK_ADDONS_CHANNEL__;
  }
  return null;
};
```

#### Event Handler Pattern

Always cast `unknown` data to specific types in event handlers:

```typescript
channel.on(EVENTS.RUN_TEST, async (data: unknown) => {
  const eventData = data as { storyId?: string };
  const storyId = eventData.storyId;
  // ... rest of handler
});
```

#### Performance Optimization

**Log Rendering**: Use refs for incremental DOM updates to improve performance:

```typescript
const logRef = useRef<HTMLDivElement>(null);
const lastLogLength = useRef(0);

useEffect(() => {
  const el = logRef.current;
  if (!el) return;

  // Append only new lines to avoid re-rendering entire log
  for (let i = lastLogLength.current; i < logs.length; i++) {
    const line = logs[i];
    // Parse and render line...
    const p = document.createElement('p');
    p.textContent = renderedLine;
    el.appendChild(p);
  }
  lastLogLength.current = logs.length;
  el.scrollTop = el.scrollHeight;
}, [logs]);
```

#### UI Component Patterns

**Button Icons**: Use Storybook's icon library consistently:

```typescript
import { PlayIcon, SyncIcon, DownloadIcon, EyeIcon, PhotoIcon } from '@storybook/icons';

<Button title="Run visual regression test for the current story">
  <PlayIcon className={styles.buttonIcon} />
  Test Current
</Button>
```

**Active State Styling**: Apply active states for interactive elements:

```css
.diffButtonActive {
  background-color: rgba(115, 130, 140, 0.1);
}
```

#### Error Handling in Addons

- Always provide fallbacks for undefined values: `title || sid || 'Unknown Story'`
- Handle missing story data gracefully
- Provide clear error messages in console logs
- Use try-catch blocks around critical operations

### CLI Command Structure Updates

#### New Command Options

**Screenshot Options**:

- `--full-page`: Take full-page screenshots instead of viewport screenshots
- `--threshold`: Pixel difference threshold for comparisons
- `--max-diff-pixels`: Maximum number of different pixels allowed

**Timeout Options**:

- `--nav-timeout`: Navigation timeout in milliseconds
- `--wait-timeout`: Element wait timeout in milliseconds
- `--overlay-timeout`: Overlay hide timeout in milliseconds
- `--stabilize-interval`: Stabilization check interval
- `--stabilize-attempts`: Number of stabilization attempts
- `--final-settle`: Final settle time before screenshot
- `--resource-settle`: Resource loading settle time

#### Configuration Override Examples

```bash
# Override config with CLI options
storybook-visual-regression test --full-page --threshold 0.1

# Use custom config file
storybook-visual-regression test --config custom-config.json

# Override output directory
storybook-visual-regression test --output "test/visual-regression"
```

### Development Best Practices Updates

#### Code Quality

- **ESLint**: Always fix ESLint errors before committing
- **TypeScript**: Use proper typing, avoid `any` types
- **Unused Imports**: Remove unused imports and variables
- **Empty Blocks**: Avoid empty catch blocks or provide meaningful error handling

#### Build Process

- Always run `npm run build` after making changes
- Test locally before committing
- Use `npm run build` in both main project and addon directory
- Copy CSS modules to dist directory in postbuild step

#### File Organization

- Keep CSS modules with their components
- Use TypeScript interfaces for all data structures
- Separate concerns between CLI, addon, and core logic
- Maintain consistent naming conventions

### Updated Dependencies

- **Core**: `@playwright/test`, `commander`, `chalk`, `ora`
- **Dev**: `typescript`, `eslint`, `prettier`, `vitest`
- **Addon**: `@storybook/manager-api`, `@storybook/components`, `@storybook/icons`
- **Peer**: `@playwright/test` (user must install)

## Updated Remember List

- **WebServer first**: Always use Playwright's webServer for server management
- **Port detection**: Extract ports from commands when possible
- **Error context**: Provide helpful troubleshooting steps
- **Cleanup**: Always clean up processes and temp files
- **Playwright reporter**: Prefer the Playwright reporter path over direct CLI
- **Direct configuration**: Pass all options through configuration objects, not environment variables
- **Config persistence**: Always persist CLI overrides back to config file
- **Type safety**: Properly type all Storybook addon channels and event handlers
- **Performance**: Use refs for incremental DOM updates in React components
- **UI consistency**: Use Storybook's icon library and component system
- **Git hygiene**: Always update .gitignore when adding new generated files or directories
- **Documentation**: Update README.md when making significant changes to functionality or usage
- **Build verification**: Always test builds locally before committing changes
- **Agent Memory Maintenance**: Keep AGENTS.md up to date by adding new architectural decisions, patterns, and learnings as they are discovered or implemented

## Publishing and Deployment Workflow

### CLI Package Publishing Process

**CRITICAL**: Follow this exact workflow when publishing new versions of the CLI package.

#### 1. Pre-Publishing Checklist

- ✓ **Build verification**: Always run `npm run build` in the CLI directory before publishing
- ✓ **Test locally**: Verify changes work before committing
- ✓ **Version bump**: Use `npm version patch/minor/major` for proper versioning
- ✓ **Git commit**: Commit changes with descriptive messages before publishing

#### 2. Publishing Steps

1. **Navigate to CLI directory**: `cd cli`
2. **Build the package**: `npm run build`
3. **Bump version**: `npm version patch` (or `minor`/`major` as needed)
4. **Publish**: `npm publish`
5. **Verify publication**: Check npm registry for the new version

#### 3. Cleanup Old Versions

**CRITICAL**: Always unpublish older versions to keep the registry clean.

1. **Check published versions**: `npm view @storybook-visual-regression/cli versions --json`
2. **Unpublish old versions**: `npm unpublish @storybook-visual-regression/cli@OLD_VERSION`
3. **Verify cleanup**: Confirm only the latest version remains

#### 4. Docker Image Rebuild

After publishing a new CLI version, rebuild the Docker image:

```bash
# Navigate to project root
cd ..

# Rebuild Docker image with no cache
docker build --no-cache -t storybook-visual-regression .
```

**Why use --no-cache**: Ensures the Docker image pulls the latest published CLI version instead of using cached layers.

#### 5. Project Installation

Install the new CLI version in target projects:

```bash
# Navigate to target project (e.g., Mercury)
cd /path/to/target/project

# Clear npm cache and install latest version
npm cache clean --force
npm install @storybook-visual-regression/cli@latest

# Verify installation
npm list @storybook-visual-regression/cli
```

### Complete Workflow Example

```bash
# 1. Build and publish CLI
cd cli
npm run build
npm version patch
npm publish

# 2. Cleanup old versions
npm unpublish @storybook-visual-regression/cli@1.5.12

# 3. Rebuild Docker image
cd ..
docker build --no-cache -t storybook-visual-regression .

# 4. Install in target project
cd /Users/uk45006208/Projects/mercury
npm cache clean --force
npm install @storybook-visual-regression/cli@latest
npm list @storybook-visual-regression/cli
```

### Workflow Best Practices

#### Version Management

- **Semantic versioning**: Use `patch` for bug fixes, `minor` for new features, `major` for breaking changes
- **Single source of truth**: Only publish from the main CLI package, not from other locations
- **Registry hygiene**: Always unpublish old versions to prevent confusion

#### Docker Integration

- **No cache rebuilds**: Always use `--no-cache` when rebuilding Docker images after CLI updates
- **Tag consistency**: Use consistent Docker tags for easy reference
- **Verification**: Test Docker images locally before deployment

#### Project Integration

- **Cache clearing**: Always clear npm cache before installing new versions
- **Verification**: Always verify installations with `npm list`
- **Consistency**: Use the same version across all projects when possible

#### Error Handling

- **Registry propagation**: Wait for npm registry propagation if installation fails
- **Version conflicts**: Handle version conflicts gracefully with cache clearing
- **Rollback plan**: Keep previous versions available for quick rollback if needed

### Common Issues and Solutions

#### "No matching version found" Error

- **Cause**: npm registry hasn't propagated the new version yet
- **Solution**: Wait a few minutes and try again, or clear npm cache

#### Docker Build Failures

- **Cause**: Docker cache contains old CLI version
- **Solution**: Always use `--no-cache` flag when rebuilding after CLI updates

#### Version Conflicts

- **Cause**: Multiple versions installed or cached
- **Solution**: Clear npm cache and reinstall with specific version

### Workflow Automation

For future automation, consider:

1. **CI/CD Pipeline**: Automate the build, test, and publish process
2. **Version Management**: Use automated version bumping based on commit messages
3. **Docker Integration**: Automatically rebuild Docker images on CLI updates
4. **Project Updates**: Automatically update dependent projects with new CLI versions

### Security Considerations

- **npm Authentication**: Ensure proper npm authentication before publishing
- **Package Integrity**: Verify package contents before publishing
- **Access Control**: Limit who can publish packages to prevent unauthorized releases
