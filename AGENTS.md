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
```

### 11. Development Workflow

1. Make changes to TypeScript files
2. Run `npm run build` to compile
3. Test locally with `npm link` or direct execution
4. Commit changes with descriptive messages
5. Version bump and publish

### 12. Dependencies

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
- **Git hygiene**: Always update .gitignore when adding new generated files or directories
- **Documentation**: Update README.md when making significant changes to functionality or usage
