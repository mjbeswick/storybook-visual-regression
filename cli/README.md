# Storybook Visual Regression CLI

A comprehensive command-line tool for visual regression testing of Storybook projects. This CLI integrates with Playwright to automatically discover all stories in your Storybook and compare them against visual baselines.

## Features

### 🎯 Core Capabilities

- **Automatic story discovery** - Automatically finds and tests all stories in your Storybook
- **Visual comparison** - Pixel-perfect screenshot comparison using odiff
- **Smart stabilization** - Waits for DOM mutations, animations, and network activity
- **Parallel execution** - Run multiple tests simultaneously for faster results
- **Multiple browsers** - Support for Chromium, Firefox, and WebKit
- **Flexible configuration** - JSON, JavaScript, or TypeScript config files
- **CI/CD ready** - Perfect for continuous integration pipelines

### 🚀 Advanced Features

- **Story filtering** - Include/exclude stories by pattern matching
- **Custom timeouts** - Fine-tune timeouts for different story types
- **Baseline management** - Easy update and management of visual baselines
- **Failure handling** - Retry logic and graceful error handling
- **Progress tracking** - Real-time progress updates and time estimates
- **JSON output** - Machine-readable test results for CI/CD integration
- **Cross-platform** - Works on macOS, Windows, and Linux
- **Docker support** - Consistent font rendering across platforms

## Installation

```bash
npm install --save-dev @storybook-visual-regression/cli
```

### Prerequisites

- **Node.js** >= 20.0.0
- **Playwright browsers** installed (Chromium recommended)
- **Storybook** project

Install Playwright browsers:

```bash
npx playwright install chromium
```

## Quick Start

### 1. Initialize Configuration (Optional)

Create a configuration file with default settings:

```bash
npx storybook-visual-regression init
```

This creates a `svr.config.js` file that you can customize.

### 2. Run Tests

If Storybook is already running:

```bash
npx storybook-visual-regression test
```

If you need the CLI to start Storybook automatically:

```bash
npx storybook-visual-regression test --command "npm run storybook"
```

### 3. Update Baselines

After making intentional visual changes:

```bash
npx storybook-visual-regression test --update
```

## Usage

### Basic Commands

#### Run Tests

```bash
npx storybook-visual-regression test
```

#### Update Baselines

```bash
npx storybook-visual-regression test --update
```

#### Initialize Config

```bash
npx storybook-visual-regression init
```

### Command-Line Options

#### Storybook Configuration

- `--url <url>` - Storybook server URL (default: `http://localhost:9009`)
- `--command <command>` - Command to start Storybook server (e.g., `npm run storybook`)
- `--port <number>` - Storybook server port (default: `6006`)

#### Test Execution

- `--workers <number>` - Number of parallel workers (default: `12`)
- `--retries <number>` - Number of retries on failure (default: `0`)
- `--max-failures <number>` - Stop after N failures (default: `10`, `0` = stop on first failure)
- `--output <dir>` - Output directory for results (default: `visual-regression`)
- `--grep <pattern>` - Filter stories by regex pattern
- `--include <patterns>` - Include stories matching these patterns (comma-separated)
- `--exclude <patterns>` - Exclude stories matching these patterns (comma-separated)

#### Browser Configuration

- `--browser <browser>` - Browser to use: `chromium`, `firefox`, or `webkit` (default: `chromium`)
- `--timezone <timezone>` - Browser timezone (default: `Europe/London`)
- `--locale <locale>` - Browser locale (default: `en-GB`)

#### Screenshot Configuration

- `--threshold <number>` - Screenshot comparison threshold (0.0-1.0, default: `0.2`)
- `--max-diff-pixels <number>` - Maximum number of pixels that can differ (default: `0`)
- `--full-page` - Capture full-page screenshots

#### Timing and Stability

- `--wait-timeout <ms>` - Wait-for-element timeout in milliseconds
- `--overlay-timeout <ms>` - Maximum time to wait for Storybook's 'preparing' overlays to hide (default: `5000`)
- `--test-timeout <ms>` - Playwright test timeout: maximum time for each test to complete
- `--snapshot-retries <count>` - Number of times to retry taking screenshot if it fails (default: `1`)
- `--snapshot-delay <ms>` - Delay before taking screenshot (default: `0`)
- `--mutation-timeout <ms>` - DOM stabilization timeout: wait after last DOM mutation (default: `100`)
- `--mutation-max-wait <ms>` - Maximum total time to wait for DOM to stabilize (default: `10000`)
- `--webserver-timeout <ms>` - Playwright webServer startup timeout (default: `120000`)

#### Advanced Options

- `--not-found-check` - Enable detection and retry for "Not Found" / 404 pages
- `--not-found-retry-delay <ms>` - Delay between "Not Found" retries (default: `200`)
- `--missing-only` - Only create snapshots that do not already exist
- `--failed-only` - Run only the tests that failed in the previous test run
- `--config <path>` - Path to config file

#### Display Options

- `--quiet` - Suppress verbose failure output
- `--debug` - Enable debug logging
- `--print-urls` - Show story URLs inline with test results
- `--progress` - Show progress spinners and time estimates
- `--no-progress` - Disable progress spinners (useful for CI pipelines)

#### CI/CD Options

- `--install-browsers [browser]` - Install Playwright browsers before running (`chromium`, `firefox`, `webkit`, or `all`)
- `--install-deps` - Install system dependencies for browsers (Linux CI)
- `--save-config` - Save CLI options to config file for future use

### Examples

#### Run Tests with Custom Configuration

```bash
npx storybook-visual-regression test \
  --url http://localhost:6006 \
  --workers 8 \
  --browser chromium \
  --threshold 0.1
```

#### Test Specific Stories

```bash
npx storybook-visual-regression test --grep "Button|Modal"
```

#### Update Baselines for Failed Tests Only

```bash
npx storybook-visual-regression test --update --failed-only
```

#### CI/CD Pipeline

```bash
npx storybook-visual-regression test \
  --command "npm run storybook" \
  --url http://localhost:6006 \
  --workers 4 \
  --threshold 0.5 \
  --max-diff-pixels 200 \
  --timezone UTC \
  --locale en-US \
  --no-progress \
  --max-failures 0
```

## Configuration

The CLI supports configuration via config files, CLI flags, or environment variables. CLI flags always override config file values.

### Config File Formats

The CLI automatically discovers config files in this order:

1. `svr.config.js` (JavaScript)
2. `svr.config.ts` (TypeScript)
3. `.svrrc.json` (JSON)

You can also specify a custom config file with `--config <path>`.

### Initialize Config

Create a default config file:

```bash
npx storybook-visual-regression init
```

Create a TypeScript config:

```bash
npx storybook-visual-regression init --format ts
```

Create a JSON config:

```bash
npx storybook-visual-regression init --format json
```

### Config File Example

**`svr.config.js`:**

```javascript
export default {
  // Storybook server configuration
  url: 'http://localhost:6006',
  command: 'npm run storybook', // Comment out if Storybook is already running

  // Test execution
  workers: 16, // Number of parallel workers
  retries: 0, // Number of retries on failure
  maxFailures: 10, // Stop after N failures (0 = no limit)
  output: 'visual-regression', // Output directory for results

  // Browser settings
  browser: 'chromium', // 'chromium' | 'firefox' | 'webkit'
  timezone: 'Europe/London',
  locale: 'en-GB',

  // Performance tuning
  waitTimeout: 30000, // Wait-for-element timeout (ms)
  overlayTimeout: 5000, // Storybook overlay timeout (ms)
  webserverTimeout: 120000, // Webserver startup timeout (ms)
  snapshotRetries: 1, // Number of times to retry taking screenshot
  snapshotDelay: 0, // Delay before taking screenshot (ms)
  mutationTimeout: 100, // DOM stabilization timeout (ms)
  mutationMaxWait: 10000, // Maximum time to wait for DOM stabilization (ms)
  waitUntil: 'load', // 'load' | 'domcontentloaded' | 'networkidle' | 'commit'

  // Story filtering (optional)
  // include: ['Components/*', 'Screens/*'],
  // exclude: ['**/Docs', '**/Experimental'],
  // grep: 'button|modal',

  // Screenshot configuration
  threshold: 0.2, // Comparison threshold (0.0-1.0)
  maxDiffPixels: 0, // Maximum pixels that can differ
  fullPage: false, // Capture full-page screenshots

  // Display options
  quiet: false, // Suppress verbose failure output
  debug: false, // Enable debug logging
  printUrls: false, // Show story URLs inline with test results
  noProgress: false, // Disable progress spinners (useful for CI)

  // Advanced options
  notFoundCheck: false, // Enable 'Not Found' content heuristic
  notFoundRetryDelay: 200, // Delay between Not Found retries (ms)
};
```

### Configuration Precedence

1. **CLI flags** (highest priority)
2. **Config file values**
3. **Environment variables** (fallback)
4. **Default values** (lowest priority)

### Environment Variables

You can set default values via environment variables:

```bash
SVR_URL=http://localhost:6006 \
SVR_WORKERS=8 \
npx storybook-visual-regression test
```

## Output Structure

After running tests, you'll find:

```
visual-regression/
├── snapshots/              # Baseline screenshots (committed to git)
│   └── ComponentName/
│       └── StoryName.png
└── results/                # Test results (gitignored)
    └── storybook-Visual-Regression-<hash>/
        ├── screenshot.png  # Actual screenshot
        └── diff.png       # Diff image (if test failed)
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Visual Regression Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npx playwright install chromium --with-deps
      - run: |
          npx storybook-visual-regression test \
            --command "npm run storybook" \
            --url http://localhost:6006 \
            --workers 4 \
            --threshold 0.5 \
            --max-diff-pixels 200 \
            --timezone UTC \
            --locale en-US \
            --no-progress \
            --max-failures 0
      - uses: actions/upload-artifact@v3
        if: failure()
        with:
          name: visual-regression-results
          path: visual-regression/results/
```

### Docker (Cross-Platform Consistency)

For consistent font rendering across platforms:

```bash
docker build -t storybook-visual-regression .
docker run --rm \
  -v $(pwd):/app \
  -w /app \
  storybook-visual-regression
```

See the root [CROSS-PLATFORM-FONTS.md](../CROSS-PLATFORM-FONTS.md) for more details.

## Troubleshooting

### Tests Not Running

**Problem**: CLI can't connect to Storybook

**Solutions**:

- Ensure Storybook is running at the specified URL
- Check the `--url` flag matches your Storybook server URL
- Verify firewall/network settings
- Use `--debug` flag for more information

### False Positives (Font Rendering)

**Problem**: Tests fail due to font rendering differences between platforms

**Solutions**:

- Use Docker for consistent rendering (see [CROSS-PLATFORM-FONTS.md](../CROSS-PLATFORM-FONTS.md))
- Increase `--threshold` and `--max-diff-pixels` for CI environments
- Use `--timezone UTC` and `--locale en-US` for consistency

### Slow Test Execution

**Problem**: Tests take too long to run

**Solutions**:

- Increase `--workers` for more parallelism
- Reduce `--snapshot-retries` and `--snapshot-delay`
- Use `--mutation-timeout` and `--mutation-max-wait` to fine-tune DOM stabilization
- Filter stories with `--include` or `--exclude` to test only what you need

### Memory Issues

**Problem**: Tests fail due to memory errors

**Solutions**:

- Reduce `--workers` count
- Use `--max-failures` to stop early
- Increase Node.js memory limit: `NODE_OPTIONS="--max-old-space-size=4096"`

### Baseline Update Issues

**Problem**: Baselines don't update or persist

**Solutions**:

- Check file permissions for the `visual-regression/snapshots/` directory
- Ensure sufficient disk space
- Verify write permissions in the project directory
- Use `--missing-only` to only create new baselines

## JSON Output

For CI/CD integration, the CLI can output JSON results:

```bash
npx storybook-visual-regression test --json
```

The JSON output includes:

```json
{
  "status": "passed|failed|error",
  "startTime": 1697548800000,
  "duration": 5432,
  "totalTests": 10,
  "passed": 8,
  "failed": 2,
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
          "path": "visual-regression/results/.../screenshot.png",
          "type": "image/png"
        }
      ]
    }
  ]
}
```

## API Reference

The CLI uses Playwright under the hood. Key concepts:

- **Stories** are discovered automatically from Storybook's `index.json`
- **Screenshots** are taken after DOM stabilization
- **Comparison** uses odiff for pixel-perfect comparison
- **Baselines** are stored in `visual-regression/snapshots/`
- **Results** are stored in `visual-regression/results/`

## Contributing

Contributions are welcome! See the root [README.md](../README.md) for development setup.

## License

MIT

## Related

- **[Addon Documentation](../addon/README.md)** - Storybook addon with UI integration
- **[Cross-Platform Fonts Guide](../CROSS-PLATFORM-FONTS.md)** - Font rendering consistency
- **[Main Repository](https://github.com/mjbeswick/storybook-visual-regression)** - Source code and issues
