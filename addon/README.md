# Storybook Visual Regression Addon

A fully functional Storybook addon that integrates visual regression testing directly into your Storybook UI with a built-in API server.

> **✅ FULLY FUNCTIONAL**: This addon includes a built-in API server that runs alongside Storybook, allowing you to execute visual regression tests directly from the Storybook UI without any external dependencies!

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
- **Smart terminal display** - xterm.js terminal with automatic resizing and Bluloco Light theme
- **Log preservation** - Terminal logs persist between test runs for better debugging
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
- **Responsive panel** - Adapts to different panel sizes and orientations with automatic terminal resizing
- **Smart terminal sizing** - Terminal automatically fills available space with precise font calculations
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

## How It Works

1. **Addon Preset** (Node.js) - Starts HTTP API server on port 6007 when Storybook loads
2. **Browser UI** - Panel and toolbar in Storybook
3. **API Communication** - Browser calls API when you click "Test Story"
4. **CLI Execution** - API server spawns `storybook-visual-regression` CLI
5. **Stream Results** - Output streams back to UI via Server-Sent Events
6. **Display Results** - Panel shows pass/fail status

## Installation

```bash
npm install --save-dev @storybook-visual-regression/addon
```

### Peer Dependency Conflicts

If you encounter peer dependency conflicts with Storybook versions, you can resolve them using:

```bash
# Option 1: Use legacy peer deps (recommended)
npm install --save-dev @storybook-visual-regression/addon --legacy-peer-deps

# Option 2: Force installation
npm install --save-dev @storybook-visual-regression/addon --force
```

The addon supports Storybook versions 7.x, 8.x, and 9.x, but npm may show conflicts due to strict peer dependency resolution.

## Setup

### 1. Register the addon

Add the addon to your `.storybook/main.js` or `.storybook/main.ts`:

```javascript
module.exports = {
  addons: [
    // ... other addons
    '@storybook-visual-regression/addon',
  ],
};
```

### 2. Prerequisites

This addon requires the `@storybook-visual-regression/cli` CLI tool to be installed:

```bash
npm install --save-dev @storybook-visual-regression/cli
```

Make sure Playwright browsers are installed:

```bash
npx playwright install chromium
```

### 3. Configuration (Optional)

The addon will use the default configuration from your `svr.config.js` file if it exists. You can create one with:

```bash
npx @storybook-visual-regression/cli init
```

#### Addon Configuration

You can configure the addon through Storybook's main configuration:

**`.storybook/main.js` or `.storybook/main.ts`:**

```javascript
module.exports = {
  addons: [
    // ... other addons
    {
      name: '@storybook-visual-regression/addon',
      options: {
        port: 6008, // Custom API server port
        cliCommand: 'npx @storybook-visual-regression/cli', // Custom CLI command
      },
    },
  ],
};
```

#### Configuration Examples

**Basic Configuration:**

```javascript
// .storybook/main.js
module.exports = {
  addons: ['@storybook-visual-regression/addon'],
};
```

**Custom Port:**

```javascript
// .storybook/main.js
module.exports = {
  addons: [
    {
      name: '@storybook-visual-regression/addon',
      options: {
        port: 6008,
      },
    },
  ],
};
```

**Custom CLI Command:**

```javascript
// .storybook/main.js
module.exports = {
  addons: [
    {
      name: '@storybook-visual-regression/addon',
      options: {
        cliCommand: 'npx @storybook-visual-regression/cli',
      },
    },
  ],
};
```

**Docker CLI Command (for cross-platform consistency):**

```javascript
// .storybook/main.js
module.exports = {
  addons: [
    {
      name: '@storybook-visual-regression/addon',
      options: {
        cliCommand: 'docker run --rm -v $(pwd):/app @storybook-visual-regression/cli',
      },
    },
  ],
};
```

**Note:** When using Docker commands with `host.docker.internal` URLs, the addon automatically replaces `host.docker.internal` with `localhost` in the terminal output, making URLs clickable from your host machine.

**Default Configuration:**

- **API Server Port**: 6007
- **CLI Command**: `@storybook-visual-regression/cli`

#### Cross-Platform Considerations

**⚠️ Important: Font Rendering Differences**

If you're running visual regression tests in GitHub Actions (Linux) but developing locally on macOS or Windows, you may encounter font rendering differences that cause false positives. This happens because:

- **Linux**: Uses different font rendering engines (FreeType)
- **macOS**: Uses Core Text with different font smoothing
- **Windows**: Uses DirectWrite with different font rendering

**Solution: Use Docker for Consistency**

To ensure consistent font rendering across all platforms, use the Docker CLI command:

```javascript
// .storybook/main.js
module.exports = {
  addons: [
    {
      name: '@storybook-visual-regression/addon',
      options: {
        cliCommand: 'docker run --rm -v $(pwd):/app @storybook-visual-regression/cli',
      },
    },
  ],
};
```

**Docker Setup:**

1. **Build the Docker image:**

   ```bash
   docker build -t @storybook-visual-regression/cli .
   ```

2. **Use in GitHub Actions:**

   ```yaml
   # .github/workflows/visual-regression.yml
   - name: Run Visual Regression Tests
     run: |
       docker run --rm \
         -v ${{ github.workspace }}:/app \
         -w /app \
         @storybook-visual-regression/cli
   ```

3. **Use locally (optional):**
   ```bash
   # Same command works on macOS, Windows, and Linux
   docker run --rm -v $(pwd):/app @storybook-visual-regression/cli
   ```

This ensures identical font rendering across all environments.

## Usage

### Running Tests

Once installed, you'll see visual regression controls in your Storybook UI:

#### Toolbar Buttons

- **Play icon** (▶️) - Run test for the currently selected story
- **Sync icon** (🔄) - Run tests for all stories
- **Eye icon** (👁️) - Show diff overlay in the preview iframe
- **Photo icon** (📷) - Show actual screenshot in the preview iframe

#### Panel

The Visual Regression panel shows:

- **Test Current Story** - Run a test for the active story
- **Test All Stories** - Run tests for all stories in your Storybook
- **Update Baseline** - Accept the current screenshot as the new baseline (only enabled after a failed test)
- **Clear Results** - Clear all test results from the panel
- **Real-time Terminal** - Live output from test execution
- **Test Results** - Pass/fail status with diff images

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

## Architecture

### Component Overview

The addon consists of four main components working together:

1. **Preset** (`preset.ts`) - Node.js module that starts the API server when Storybook loads
2. **Manager** (`manager.tsx`) - React component running in Storybook UI, provides panel and toolbar
3. **Preview** (`preview.ts`) - Runs in story iframe, handles communication and CLI spawning
4. **API Server** (`server.ts`) - HTTP server that manages test execution and file serving

### Communication Flow

#### Individual Story Test Flow

```
User clicks "Test Story" button in toolbar
     ↓
Manager emits 'RUN_TEST' event via Storybook channel
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
Manager emits 'RUN_ALL_TESTS' event
     ↓
Preview spawns CLI: storybook-visual-regression test --json
     ↓
CLI runs all tests, outputs comprehensive JSON results
     ↓
Preview parses results, emits multiple 'TEST_RESULT' events
     ↓
Manager updates UI with progress and individual results
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
   npm link storybook-visual-regression-addon
   ```

2. Build in watch mode:

   ```bash
   cd addon
   npm run dev
   ```

3. Start your Storybook:
   ```bash
   npm run storybook
   ```

## Troubleshooting

### Common Issues & Solutions

#### Tests Not Running

**Symptoms**: Clicking test buttons does nothing, no progress indicators appear

**Causes & Solutions**:

- **Missing CLI tool**: Ensure `@storybook-visual-regression/cli` is installed
  ```bash
  npm install --save-dev @storybook-visual-regression/cli
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
    addons: ['@storybook-visual-regression/addon'],
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

### Debug Mode

Enable debug logging to troubleshoot issues:

```bash
# Enable debug mode in CLI
npx @storybook-visual-regression/cli test --debug

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

**"Cannot find module '@storybook-visual-regression/cli'"**

- Install the CLI tool: `npm install --save-dev @storybook-visual-regression/cli`

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
