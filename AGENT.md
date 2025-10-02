# Agent Memory - Storybook Visual Regression Tool

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

### 3.1. Configuration vs Command Line Options

**CRITICAL**: Only use Playwright configuration to pass options, not command line arguments.

- ✓ **Correct**: Pass options via environment variables to Playwright config
- ✓ **Correct**: Use `updateSnapshots: process.env.PLAYWRIGHT_UPDATE_SNAPSHOTS === 'true'` in config
- ✘ **Wrong**: Use `--update-snapshots` command line argument
- ✘ **Wrong**: Use `--workers` command line argument

**Why**: Configuration-based approach is more maintainable and follows Playwright best practices.

### 4. Error Handling Patterns

- Use `reuseExistingServer: true` in webServer config
- Provide clear troubleshooting steps in error messages
- Include port detection in error diagnostics
- Always clean up processes in finally blocks

### 5. File Structure

- `src/cli/index.ts` - Main CLI entry point
- `src/core/VisualRegressionRunner.ts` - Test execution logic
- `src/core/StorybookDiscovery.ts` - Story discovery (assumes server running)
- `src/config/defaultConfig.ts` - Default configuration
- `src/types/index.ts` - TypeScript definitions

### 5.1. Output Directory Structure

**CRITICAL**: The CLI should only create one directory: `visual-regression` in the directory where the CLI is executed.

**Expected Structure**:

```
visual-regression/
├── snapshots/           # Baseline snapshot images
│   ├── story-1.png
│   ├── story-2.png
│   └── ...
└── results/            # Playwright test results
    ├── test-results/
    ├── reports/
    └── ...
```

**Directory Behavior**:

- ✓ **Correct**: Create `visual-regression/` in the current working directory where CLI is executed
- ✓ **Correct**: Use `-o` flag to specify custom output directory: `-o "test/visual-regression"`
- ✘ **Wrong**: Create `.svr-playwright/` or any other configuration directories
- ✘ **Wrong**: Create output directories in the main project directory when run from subdirectories

**Why**: This keeps the tool clean and predictable - users know exactly where their visual regression data will be stored.

### 6. Build and Publish Process

- Always run `npm run build` before publishing
- Use `npm version patch/minor/major` for versioning
- Push tags with `git push --tags`
- **NEVER publish automatically - wait for user to explicitly ask for publishing**
- Only commit and push changes, do not run `npm publish` unless requested
- **NEVER commit code until you have tested that it works**
- Test changes locally before committing to ensure functionality

### 7. Common Issues and Solutions

#### ECONNREFUSED Error

- **Cause**: Trying to connect to Storybook before it's ready
- **Solution**: Use Playwright webServer, not manual connection attempts

#### Port Mismatch

- **Cause**: Tool expects different port than Storybook runs on
- **Solution**: Extract port from storybook command or use `-p` flag

#### Server Timeout

- **Cause**: Storybook takes longer than expected to start
- **Solution**: Increase `serverTimeout` in config, use webServer health checks

### 8. Testing Commands

```bash
# Basic test
storybook-visual-regression test -c "npm run dev:ui"

# With specific port
storybook-visual-regression test -c "npm run dev:ui" -p 6006

# Update snapshots
storybook-visual-regression update -c "npm run dev:ui"

# Use Playwright reporter (recommended)
storybook-visual-regression test -c "npm run dev:ui" --use-playwright-reporter
```

### 9. Development Workflow

1. Make changes to TypeScript files
2. Run `npm run build` to compile
3. Test locally with `npm link` or direct execution
4. Commit changes with descriptive messages
5. Version bump and publish

### 10. Dependencies

- **Core**: `@playwright/test`, `commander`, `chalk`, `ora`
- **Dev**: `typescript`, `eslint`, `prettier`, `vitest`
- **Peer**: `@playwright/test` (user must install)

## Remember

- **WebServer first**: Always use Playwright's webServer for server management
- **Port detection**: Extract ports from commands when possible
- **Error context**: Provide helpful troubleshooting steps
- **Cleanup**: Always clean up processes and temp files
- **Playwright reporter**: Prefer the Playwright reporter path over direct CLI
- **Git hygiene**: Always update .gitignore when adding new generated files or directories
- **Documentation**: Update README.md when making significant changes to functionality or usage
