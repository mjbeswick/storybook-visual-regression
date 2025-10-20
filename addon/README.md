# Storybook Visual Regression Addon

A fully functional Storybook addon that integrates visual regression testing directly into your Storybook UI.

> **✅ FULLY FUNCTIONAL**: This addon includes a built-in API server that runs alongside Storybook, allowing you to execute visual regression tests directly from the Storybook UI!
>
> **How it works:**
>
> 1. The addon's preset starts an API server (port 6007) when Storybook loads
> 2. The server runs in the same Node.js process as Storybook
> 3. When you click "Test Story", the browser calls the API, which spawns the CLI tool
> 4. Results stream back to the UI in real-time via Server-Sent Events
> 5. No separate backend service needed!

## Features

### 🎯 **Individual Story Testing**

- **One-click testing** - Click the play button (▶️) in the toolbar to test the currently selected story
- **Instant feedback** - See test results immediately in the panel
- **Story-specific baselines** - Each story maintains its own visual baseline
- **Smart story detection** - Automatically detects the current story from URL parameters

### 🔄 **Batch Testing**

- **Test all stories** - Click the sync button (🔄) to run visual regression tests on your entire Storybook
- **Progress tracking** - Real-time progress updates with completion percentage
- **Parallel execution** - Tests run in parallel for faster completion
- **Comprehensive results** - See pass/fail status for all stories at once

### 📊 **Real-time Results & Monitoring**

- **Live progress updates** - Watch tests execute in real-time with streaming output
- **Visual diff display** - Side-by-side comparison of expected vs actual screenshots
- **Diff highlighting** - Overlay showing exactly what changed between baselines
- **Test status indicators** - Clear visual indicators for passed (✅), failed (❌), and error (⚠️) states
- **Execution logs** - Detailed console output showing test execution steps

### ✅ **Baseline Management**

- **One-click updates** - Accept new baselines when changes are intentional
- **Smart update mode** - Only update baselines for failed tests
- **Baseline validation** - Review diffs before accepting new baselines
- **Version control integration** - Baselines are stored as regular files for easy version control

### 🎨 **Beautiful UI Integration**

- **Seamless Storybook integration** - Native Storybook UI components and styling
- **Responsive panel** - Adapts to different panel sizes and orientations
- **Intuitive controls** - Clear, accessible buttons and controls
- **Consistent theming** - Follows Storybook's design system and dark/light themes
- **Keyboard shortcuts** - Power user features for efficient testing

### ⚡ **Built-in API Server**

- **No external dependencies** - Runs entirely within Storybook's process
- **Automatic server management** - Starts and stops with Storybook
- **RESTful API** - Clean API endpoints for test execution and results
- **Server-Sent Events** - Real-time streaming of test output and progress
- **Health monitoring** - Built-in health check endpoint for monitoring

### 🔧 **Advanced Configuration**

- **Automatic config detection** - Uses your existing `visual-regression/config.json` or `svr.config.js`
- **CLI option passthrough** - All CLI options available through the addon
- **Custom thresholds** - Per-story or global visual comparison thresholds
- **Browser selection** - Choose between Chromium, Firefox, or WebKit
- **Timeout configuration** - Fine-tune timeouts for different story types

### 📡 **Real-time Communication**

- **Event-driven architecture** - Uses Storybook's channel API for communication
- **Bidirectional updates** - Panel and toolbar stay synchronized
- **Error handling** - Graceful error handling with user-friendly messages
- **Process management** - Smart process spawning and cleanup
- **Concurrent test handling** - Prevents conflicts when multiple tests are running

### 🚀 **Performance Features**

- **Efficient image handling** - Optimized image loading and display
- **Memory management** - Automatic cleanup of test artifacts
- **Caching** - Smart caching of test results and images
- **Lazy loading** - Images loaded only when needed
- **Background processing** - Tests run without blocking the UI

### 🔍 **Debugging & Troubleshooting**

- **Detailed error messages** - Clear error descriptions with suggested solutions
- **Debug logging** - Comprehensive logging for troubleshooting
- **Test execution details** - Step-by-step execution information
- **Image comparison tools** - Built-in tools for analyzing visual differences
- **Process monitoring** - Real-time monitoring of CLI processes

## How It Works

1. **Addon Preset** (Node.js) - Starts HTTP API server on port 6007 when Storybook loads
2. **Browser UI** - Panel and toolbar in Storybook
3. **API Communication** - Browser calls API when you click "Test Story"
4. **CLI Execution** - API server spawns `storybook-visual-regression` CLI
5. **Stream Results** - Output streams back to UI via Server-Sent Events
6. **Display Results** - Panel shows pass/fail status

## Installation

```bash
npm install --save-dev storybook-visual-regression-addon
```

## Setup

### 1. Register the addon

Add the addon to your `.storybook/main.js` or `.storybook/main.ts`:

```javascript
module.exports = {
  addons: [
    // ... other addons
    'storybook-visual-regression-addon',
  ],
};
```

### 2. Prerequisites

This addon requires the `storybook-visual-regression` CLI tool to be installed:

```bash
npm install --save-dev storybook-visual-regression
```

Make sure Playwright browsers are installed:

```bash
npx playwright install chromium
```

### 3. Configuration (Optional)

The addon will use the default configuration from your `svr.config.js` file if it exists. You can create one with:

```bash
npx storybook-visual-regression init
```

## Usage

### Running Tests

Once installed, you'll see visual regression controls in your Storybook UI:

#### Toolbar Buttons

- **Play icon** (▶️) - Run test for the currently selected story
- **Sync icon** (🔄) - Run tests for all stories

#### Panel

The Visual Regression panel shows:

- **Test Current Story** - Run a test for the active story
- **Test All Stories** - Run tests for all stories in your Storybook
- **Update Baseline** - Accept the current screenshot as the new baseline (only enabled after a failed test)
- **Clear Results** - Clear all test results from the panel

### Viewing Results

After running a test, the panel displays:

- ✅ **Passed** - Visual comparison matched the baseline
- ❌ **Failed** - Visual differences detected
- ⚠️ **Error** - Test failed to run

For failed tests, you'll see:

- Side-by-side comparison of expected vs actual
- Diff image highlighting the changes
- Error messages if the test failed to run

### Updating Baselines

When a test fails due to intentional changes:

1. Review the diff in the panel
2. If the changes are expected, click **Update Baseline**
3. The new screenshot becomes the baseline for future tests

## How It Works

### Architecture Overview

The addon consists of four main components working together:

1. **Preset** (`preset.ts`) - Node.js module that starts the API server when Storybook loads
2. **Manager** (`manager.tsx`) - React component running in Storybook UI, provides panel and toolbar
3. **Preview** (`preview.ts`) - Runs in story iframe, handles communication and CLI spawning
4. **API Server** (`server.ts`) - HTTP server that manages test execution and file serving

### Detailed Component Architecture

#### 1. Preset (`preset.ts`)

- **Purpose**: Entry point that configures the addon
- **Responsibilities**:
  - Registers the addon with Storybook
  - Starts the API server on port 6007
  - Configures the manager and preview components
  - Handles addon initialization and cleanup

#### 2. Manager (`manager.tsx`)

- **Purpose**: Main UI component in Storybook's addon panel
- **Responsibilities**:
  - Renders the visual regression panel
  - Displays test results and progress
  - Handles user interactions (test buttons, baseline updates)
  - Manages test result state and UI updates
  - Shows diff images and comparison views

#### 3. Preview (`preview.ts`)

- **Purpose**: Communication bridge between Storybook and the CLI tool
- **Responsibilities**:
  - Listens for test execution events from the manager
  - Spawns CLI processes with appropriate parameters
  - Parses CLI output and extracts test results
  - Handles file path resolution for images
  - Manages process lifecycle and cleanup

#### 4. API Server (`server.ts`)

- **Purpose**: HTTP server for test execution and file serving
- **Responsibilities**:
  - Provides REST API endpoints for test execution
  - Serves test result images and files
  - Manages CLI process spawning and monitoring
  - Handles Server-Sent Events for real-time updates
  - Provides health check and status endpoints

### Communication Flow

#### Individual Story Test Flow

```
User clicks "Test Story" button in toolbar
     ↓
Manager emits 'TEST_STORY' event via Storybook channel
     ↓
Preview receives event, gets current story ID
     ↓
Preview spawns CLI: storybook-visual-regression test --json --grep "story-id"
     ↓
CLI executes Playwright test, outputs JSON results
     ↓
Preview parses JSON, extracts image paths
     ↓
Preview emits 'TEST_RESULT' event with results
     ↓
Manager updates UI with test status and diff images
```

#### Batch Test Flow

```
User clicks "Test All Stories" button
     ↓
Manager emits 'TEST_ALL_STORIES' event
     ↓
Preview spawns CLI: storybook-visual-regression test --json
     ↓
CLI runs all tests, outputs comprehensive JSON results
     ↓
Preview parses results, emits multiple 'TEST_RESULT' events
     ↓
Manager updates UI with progress and individual results
```

#### Baseline Update Flow

```
User clicks "Update Baseline" after failed test
     ↓
Manager emits 'UPDATE_BASELINE' event with story ID
     ↓
Preview spawns CLI: storybook-visual-regression update --grep "story-id"
     ↓
CLI updates baseline, outputs confirmation
     ↓
Preview emits 'BASELINE_UPDATED' event
     ↓
Manager refreshes test result display
```

### API Endpoints

The built-in API server provides these endpoints:

#### Test Execution

- `POST /api/test` - Execute individual story test
- `POST /api/test-all` - Execute all story tests
- `POST /api/update` - Update baseline for specific story

#### File Serving

- `GET /api/images/:path` - Serve test result images
- `GET /api/diff/:path` - Serve diff images
- `GET /api/expected/:path` - Serve expected baseline images

#### Monitoring

- `GET /health` - Health check endpoint
- `GET /api/status` - Current test execution status
- `GET /api/logs` - Real-time test execution logs

### Data Flow & State Management

#### Test Results Context (`TestResultsContext.tsx`)

- **Purpose**: Centralized state management for test results
- **State**:
  - `results`: Array of test results for all stories
  - `isRunning`: Boolean indicating if tests are currently running
  - `logs`: Array of log messages for real-time display
- **Methods**:
  - `addResult()`: Add new test result
  - `updateResult()`: Update existing test result
  - `clearResults()`: Clear all results
  - `addLog()`: Add log message

#### Event System

The addon uses Storybook's channel API for communication:

```typescript
// Events emitted by Manager
const EVENTS = {
  TEST_STORY: 'visual-regression/test-story',
  TEST_ALL_STORIES: 'visual-regression/test-all-stories',
  UPDATE_BASELINE: 'visual-regression/update-baseline',
  CLEAR_RESULTS: 'visual-regression/clear-results',
} as const;

// Events emitted by Preview
const RESULT_EVENTS = {
  TEST_RESULT: 'visual-regression/test-result',
  TEST_PROGRESS: 'visual-regression/test-progress',
  TEST_COMPLETE: 'visual-regression/test-complete',
  BASELINE_UPDATED: 'visual-regression/baseline-updated',
} as const;
```

### CLI Integration

#### Process Spawning

The addon spawns CLI processes with carefully constructed arguments:

```typescript
// Individual story test
const args = [
  'storybook-visual-regression',
  'test',
  '--json',
  '--grep',
  storyId,
  '--output',
  outputDir,
  '--workers',
  '1', // Single worker for individual tests
];

// Batch test
const args = [
  'storybook-visual-regression',
  'test',
  '--json',
  '--output',
  outputDir,
  '--workers',
  '4', // Multiple workers for batch tests
];
```

#### Output Parsing

The addon expects JSON output from the CLI:

```json
{
  "status": "passed|failed|error",
  "startTime": 1697548800000,
  "duration": 5432,
  "totalTests": 1,
  "passed": 1,
  "failed": 0,
  "tests": [
    {
      "storyId": "components-button--primary",
      "title": "Components / Button",
      "name": "Primary",
      "status": "passed|failed|error",
      "duration": 2341,
      "attachments": [
        {
          "name": "screenshot",
          "path": "visual-regression/results/test-results/screenshot.png",
          "type": "image/png"
        }
      ]
    }
  ]
}
```

### File Management

#### Image Path Resolution

The addon handles different image types and paths:

- **Expected images**: `visual-regression/snapshots/ComponentName/StoryName.png`
- **Actual images**: `visual-regression/results/test-results/screenshot.png`
- **Diff images**: `visual-regression/results/test-results/screenshot-diff.png`

#### File Serving

The API server serves images with proper MIME types and caching headers:

```typescript
// Serve image with proper headers
res.setHeader('Content-Type', 'image/png');
res.setHeader('Cache-Control', 'public, max-age=3600');
res.setHeader('Access-Control-Allow-Origin', '*');
```

### Error Handling

#### Process Management

- **Timeout handling**: CLI processes are killed after reasonable timeouts
- **Error detection**: Process exit codes and stderr are monitored
- **Cleanup**: Processes are properly cleaned up on completion or error

#### User Experience

- **Graceful degradation**: UI remains functional even if tests fail
- **Clear error messages**: User-friendly error descriptions
- **Retry mechanisms**: Automatic retries for transient failures
- **Progress indication**: Clear progress indicators during long operations

## Development

### Building the Addon

```bash
cd addon
npm install
npm run build
```

### Local Development

To develop the addon locally:

1. Link the addon to your project:

   ```bash
   cd addon
   npm link

   cd your-project
   npm link @storybook-visual-regression/addon
   ```

2. Build in watch mode:

   ```bash
   cd addon
   npm run watch
   ```

3. Start your Storybook:
   ```bash
   npm run storybook
   ```

### Extending the Addon

The addon can be extended with:

- **Custom reporters** - Add your own test result formatters
- **Threshold configuration** - Per-story tolerance settings
- **Test history** - Track results over time in a database
- **Integration with CI** - Show CI test results in the addon
- **Batch operations** - Multi-select stories for testing
- **Keyboard shortcuts** - Quick actions for power users

## Limitations

### Future Improvements

- **Server Mode** - Long-running server for faster individual tests
- **Image Proxy** - Server-side image serving for better browser compatibility
- **Queue Management** - Better handling of concurrent test requests
- **Incremental Updates** - Update individual baselines without full CLI run
- **Performance Metrics** - Track test execution times and bottlenecks
- **WebSocket Communication** - Replace Server-Sent Events with WebSockets for better real-time updates
- **Caching Layer** - Cache test results and images for faster subsequent runs
- **Batch Operations** - Multi-select stories for testing
- **Keyboard Shortcuts** - Quick actions for power users
- **Test History** - Track results over time in a database
- **Integration with CI** - Show CI test results in the addon

## Troubleshooting

### Common Issues & Solutions

#### Tests Not Running

**Symptoms**: Clicking test buttons does nothing, no progress indicators appear

**Causes & Solutions**:

- **Missing CLI tool**: Ensure `storybook-visual-regression` is installed
  ```bash
  npm install --save-dev storybook-visual-regression
  ```
- **Playwright not installed**: Install Playwright browsers
  ```bash
  npx playwright install chromium
  ```
- **Port conflicts**: API server port 6007 is already in use
  - Check if another process is using port 6007: `lsof -i :6007`
  - Restart Storybook to free the port
- **Permission issues**: CLI tool lacks execution permissions
  ```bash
  chmod +x node_modules/.bin/storybook-visual-regression
  ```

#### Images Not Loading

**Symptoms**: Test results show broken images or "Image not found" errors

**Causes & Solutions**:

- **File path issues**: Images are served from incorrect paths
  - Check that `visual-regression/` directory exists
  - Verify image files are created after test runs
  - Use absolute paths: `--output /absolute/path/to/visual-regression`
- **Browser security restrictions**: Some browsers block `file://` URLs
  - Use the built-in API server (default behavior)
  - Ensure API server is running on port 6007
- **CORS issues**: Cross-origin requests blocked
  - API server includes CORS headers by default
  - Check browser console for CORS errors
- **File permissions**: Images cannot be read by the API server
  ```bash
  chmod -R 644 visual-regression/
  ```

#### Addon Not Appearing

**Symptoms**: No visual regression panel or toolbar buttons visible

**Causes & Solutions**:

- **Addon not registered**: Check `.storybook/main.js` includes the addon
  ```javascript
  module.exports = {
    addons: ['storybook-visual-regression-addon'],
  };
  ```
- **Storybook not restarted**: Restart Storybook after adding the addon
- **Version compatibility**: Ensure addon version is compatible with Storybook version
- **Build errors**: Check Storybook terminal for addon build errors
- **Panel not enabled**: Enable the panel in Storybook's addon panel selector

#### Test Execution Failures

**Symptoms**: Tests start but fail with errors

**Causes & Solutions**:

- **Storybook not running**: Ensure Storybook is accessible at the configured URL
- **Timeout issues**: Increase timeout settings
  ```bash
  # In your config file
  {
    "navTimeout": 30000,
    "waitTimeout": 60000,
    "webserverTimeout": 180000
  }
  ```
- **Memory issues**: Reduce worker count for large test suites
  ```bash
  # Use fewer workers
  --workers 2
  ```
- **Browser crashes**: Switch to a different browser
  ```bash
  # Try Firefox or WebKit
  --browser firefox
  ```

#### Performance Issues

**Symptoms**: Tests run slowly or UI becomes unresponsive

**Causes & Solutions**:

- **Too many workers**: Reduce parallel workers
  ```bash
  --workers 2
  ```
- **Large images**: Optimize screenshot settings
  ```bash
  --threshold 0.3  # Allow more pixel differences
  --full-page false  # Capture viewport only
  ```
- **Memory leaks**: Restart Storybook periodically during long testing sessions
- **Network issues**: Use local Storybook instead of remote URLs

#### Baseline Update Issues

**Symptoms**: Baseline updates fail or don't persist

**Causes & Solutions**:

- **File permissions**: Ensure write permissions to snapshot directory
  ```bash
  chmod -R 755 visual-regression/snapshots/
  ```
- **Disk space**: Check available disk space
- **Concurrent updates**: Avoid running multiple update operations simultaneously
- **Path resolution**: Use absolute paths for output directory

#### API Server Issues

**Symptoms**: API server fails to start or respond

**Causes & Solutions**:

- **Port conflicts**: Port 6007 is already in use
  - Kill existing process: `kill -9 $(lsof -t -i:6007)`
  - Or restart Storybook
- **Firewall blocking**: Check firewall settings for port 6007
- **Node.js version**: Ensure Node.js version >= 18
- **Memory issues**: Increase Node.js memory limit
  ```bash
  NODE_OPTIONS="--max-old-space-size=4096" npm run storybook
  ```

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
# Enable debug mode in CLI
npx storybook-visual-regression test --debug

# Check browser console for addon errors
# Open Developer Tools → Console tab

# Check Storybook terminal for server errors
# Look for error messages in the terminal where Storybook is running
```

### Getting Help

#### Check Logs

1. **Browser Console**: Open Developer Tools → Console for client-side errors
2. **Storybook Terminal**: Check terminal where Storybook is running for server errors
3. **CLI Output**: Run CLI directly to see detailed error messages
4. **Network Tab**: Check Network tab for failed API requests

#### Common Error Messages

**"Cannot find module 'storybook-visual-regression'"**

- Install the CLI tool: `npm install --save-dev storybook-visual-regression`

**"Port 6007 is already in use"**

- Kill existing process or restart Storybook

**"ECONNREFUSED"**

- Storybook server is not running or not accessible

**"Test timeout exceeded"**

- Increase timeout settings or check for slow-loading stories

**"Permission denied"**

- Check file permissions for visual-regression directory

#### Reporting Issues

When reporting issues, include:

1. **Storybook version**: `npx storybook --version`
2. **Addon version**: Check `package.json`
3. **Node.js version**: `node --version`
4. **Operating system**: OS and version
5. **Error messages**: Full error output from console and terminal
6. **Steps to reproduce**: Detailed steps to reproduce the issue
7. **Expected behavior**: What should happen
8. **Actual behavior**: What actually happens

## Related Projects

- [storybook-visual-regression](https://github.com/your-org/storybook-visual-regression) - The CLI tool that powers this addon
- [@storybook/addon-interactions](https://github.com/storybookjs/storybook/tree/main/addons/interactions) - Inspiration for the UI patterns
- [Playwright](https://playwright.dev/) - The test runner used under the hood

## License

MIT

## Contributing

Contributions are welcome! This is an example addon that demonstrates integration patterns. Feel free to:

- Report issues
- Suggest improvements
- Submit pull requests
- Fork and customize for your needs

## Support

For issues related to:

- **The addon itself** - Open an issue in this repository
- **Visual regression testing** - See the main `storybook-visual-regression` documentation
- **Storybook** - Visit [Storybook documentation](https://storybook.js.org/docs)
