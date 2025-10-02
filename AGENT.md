# Agent Memory - Storybook Visual Regression Tool

## Key Architectural Decisions

### 1. Use Playwright's webServer Configuration

**CRITICAL**: Always use Playwright's built-in `webServer` configuration to manage Storybook lifecycle, not manual server management.

- ✅ **Correct**: Use `webServer` in Playwright config to start/stop Storybook
- ❌ **Wrong**: Manually spawn Storybook processes and manage lifecycle
- ❌ **Wrong**: Try to connect to already-running Storybook instances

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

### 6. Build and Publish Process

- Always run `npm run build` before publishing
- Use `npm version patch/minor/major` for versioning
- Push tags with `git push --tags`
- **NEVER publish automatically - wait for user to explicitly ask for publishing**
- Only commit and push changes, do not run `npm publish` unless requested

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
storybook-visual-regression test -c "npm run storybook"

# With specific port
storybook-visual-regression test -c "npm run storybook" -p 6006

# Update snapshots
storybook-visual-regression update -c "npm run storybook"

# Use Playwright reporter (recommended)
storybook-visual-regression test -c "npm run storybook" --use-playwright-reporter
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
