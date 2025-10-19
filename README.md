## storybook-visual-regression

A comprehensive visual regression testing tool for any Storybook project using Playwright. Automatically discovers stories from a running Storybook dev server or a built `storybook-static` folder, captures deterministic screenshots, and reports pass/fail with a simple list-style output. Includes fast parallel execution, retries, fail-fast, and optional Playwright reporter integration.

**Two ways to use:**

- **CLI Tool** - Command-line interface for CI/CD and automated testing
- **Storybook Addon** - Beautiful UI integrated directly into Storybook for interactive testing

The tool automatically detects your Storybook configuration including:

- Port from package.json scripts
- Storybook command from package.json
- Viewport configurations from Storybook config files

Example output:

```
$ storybook-visual-regression test -c "npm run storybook" --url http://localhost:9009/

🚀 Starting Playwright visual regression tests
  • Storybook command: npm run storybook (npm run storybook)
  • Working directory: /Users/uk45006208/Projects/storybook-visual-regression/test
  • Waiting for Storybook output...

Running 5 tests using 5 workers

⠸ 3 of 5 ~5s remaining
  ✓ QRCode › QR Code 2 [qrcode--qr-code-2] (1.2s)
  ✓ QRCode › QR Code 4 [qrcode--qr-code-4] (1.2s)
  ✓ QRCode › QR Code 5 [qrcode--qr-code-5] (1.2s)
  ✓ QRCode › QR Code 1 [qrcode--qr-code-1] (1.2s)
  ✓ QRCode › QR Code 3 [qrcode--qr-code-3] (1.2s)

5 passed (9.7s)

🎉 Visual regression tests completed successfully
```

### Requirements

- **Node**: >= 20
- **Playwright**: `@playwright/test` as a dependency or peer (the CLI installs Chromium on postinstall by default)
- **Storybook**: either a running dev server or a built static export (`storybook-static/index.json`)

### Installation

```bash
npm install --save-dev storybook-visual-regression @playwright/test

# Optional: install all browsers
npx storybook-visual-regression install-browsers --browser all
```

### Storybook Addon

For a more integrated experience, you can also install the **Storybook addon** that provides a beautiful UI directly within Storybook:

```bash
npm install --save-dev @storybook-visual-regression/addon
```

The addon includes:

- 🎯 **Run tests directly from Storybook** - Click toolbar button to test current story
- 🔄 **Test all stories** - Run visual regression on your entire Storybook
- 📊 **Real-time results** - See test status update live in the panel
- ✅ **Update baselines** - One-click baseline updates when changes are intentional
- ⚡ **Built-in API server** - No separate backend needed!

See the [addon installation guide](addon/INSTALL.md) for detailed setup instructions.

### Quick Start

#### 1. Create a config file (recommended)

```bash
npx storybook-visual-regression init
```

This creates a `svr.config.js` file with all available options. You can also use:

- `--format ts` for TypeScript config
- `--format json` for JSON config

Example `svr.config.js`:

```javascript
export default {
  url: 'http://localhost',
  port: 9009,
  workers: 16,
  browser: 'chromium',
  waitUntil: 'domcontentloaded', // Faster than 'networkidle'
  finalSettle: 500,
  // Story filtering
  exclude: ['**/Docs'],
};
```

Config files are discovered automatically in this order:

1. `svr.config.js`
2. `svr.config.ts`
3. `svr.config.mjs`
4. `.svrrc.json`
5. `.svrrc`

You can specify a custom config path with `--config <path>`.

#### 2. Run tests

Run against a running Storybook on the default port 9009:

```bash
npx storybook-visual-regression test
```

Start Storybook automatically and test:

```bash
npx storybook-visual-regression test \
  --command "npm run storybook" \
  --url http://localhost \
  --port 9009
```

Update snapshots after intentional UI changes (cleans old snapshots by default):

```bash
npx storybook-visual-regression update
```

Skip cleaning if you want to keep existing snapshots:

```bash
npx storybook-visual-regression update --no-clean
```

Filter stories by id/title substring or glob (comma-separated):

```bash
npx storybook-visual-regression test --include button,card --exclude wip

# with globs
npx storybook-visual-regression test --include "button*" --exclude "**/wip*"

# or regex pattern
npx storybook-visual-regression test --grep "button.*primary"
```

### What it does

- Discovers stories from `GET <url>:<port>/index.json` or falls back to `storybook-static/index.json`
- Launches the chosen Playwright browser and opens each story `iframe.html?id=<storyId>`
- Waits for the page to load using `domcontentloaded`, then checks that all resources have finished loading using the Performance API
- Explicitly waits for fonts to load to ensure consistent screenshots
- Force-hides Storybook's "preparing" overlays to prevent false timeouts
- Applies deterministic settings (optional frozen time/locale/timezone, disables animations if enabled)
- Captures screenshots and writes them to the configured snapshot folder
- Prints a concise pass/fail line per story and a summary; exits non‑zero if failures occur

### CLI

Commands:

- `init`: create a default config file (js/ts/json)
- `test`: run visual regression tests
- `update`: update snapshots instead of comparing
- `install-browsers`: install Playwright browsers (`chromium|firefox|webkit|all`)

Common options (defaults shown):

- `--config <path>`: Path to config file (auto-discovers svr.config.js, .svrrc.json, etc.)
- `-u, --url <url>`: Storybook server URL (default `http://localhost`)
- `-p, --port <port>`: Storybook port (default `9009`)
- `-c, --command <cmd>`: command to start Storybook (default `npm run storybook`)
- `--webserver-timeout <ms>`: wait for Storybook to boot (default `120000`)
- `-o, --output <dir>`: results root (default `visual-regression`)
  - Snapshots: `<output>/snapshots`
  - Results: `<output>/results`
- `-w, --workers <n>`: parallel workers (default `12`)
- `--retries <n>`: retries on failure (default `0`)
- `--max-failures <n>`: stop early after N failures (default `10`, <=0 disables)
- `--browser <browser>`: Browser to use (chromium|firefox|webkit) (default `chromium`)
- `--threshold <number>`: Screenshot comparison threshold (0.0-1.0) (default `0.2`)
- `--max-diff-pixels <number>`: Maximum number of pixels that can differ (default `0`)
- `--timezone <tz>`: e.g. `Europe/London` (default `Europe/London`)
- `--locale <bcp47>`: e.g. `en-GB` (default `en-GB`)
- `--reporter <reporter>`: Playwright reporter (list|line|dot|json|junit) (default `list`)
- `--quiet`: suppress verbose failure output, show only test progress
- `--debug`: print environment information before running Playwright
- `--print-urls`: show story URLs inline with test results

**Performance & Stability Options:**

- `--nav-timeout <ms>`: navigation timeout in ms (default `10000`)
- `--wait-timeout <ms>`: wait-for-element timeout in ms (default `10000` for test, `30000` for update)
- `--overlay-timeout <ms>`: timeout waiting for Storybook preparing overlays to hide (default `5000`)
- `--stabilize-interval <ms>`: interval between canvas stability checks in ms (default `200` for test, `150` for update)
- `--stabilize-attempts <n>`: number of canvas stability checks (default `20`)
- `--final-settle <ms>`: final settle delay after readiness checks (default `500`)
- `--resource-settle <ms>`: time to wait after a resource finishes loading before considering all resources settled (default `100`)
- `--wait-until <state>`: navigation waitUntil strategy: `load`|`domcontentloaded`|`networkidle`|`commit` (default `networkidle`)

**Story Filtering & Update Options:**

- `--include <patterns>`: include stories matching patterns (comma-separated, supports globs)
- `--exclude <patterns>`: exclude stories matching patterns (comma-separated, supports globs)
- `--grep <pattern>`: filter stories by regex pattern
- `--missing-only`: (update command only) only create snapshots for stories without existing baselines
- `--no-clean`: (update command only) skip deleting existing snapshots before updating (by default, update cleans snapshots)

**CI Options:**

- `--install-browsers [browser]`: install Playwright browsers before running (default `chromium`, options: `chromium|firefox|webkit|all`)
- `--install-deps`: install system dependencies for browsers (useful on Linux CI images)
- `--hide-time-estimates`: hide time estimates in progress display
- `--hide-spinners`: hide progress spinners (useful for CI)

**Advanced:**

- `--not-found-check`: enable a heuristic that fails when the host app shows a "Not Found"/404 page
- `--not-found-retry-delay <ms>`: delay between Not Found retries (default `200`)

### Example workflows

**Create snapshots for first time:**

```bash
# Using config file (recommended)
npx storybook-visual-regression init
npx storybook-visual-regression update

# Or with CLI options
npx storybook-visual-regression update \
  --command "npm run storybook" \
  --url http://localhost:9009
```

**Update snapshots after UI changes (cleans old snapshots):**

```bash
# Update all snapshots
npx storybook-visual-regression update

# Update specific component (cleans only matching snapshots)
npx storybook-visual-regression update --include "MyComponent"

# Update without cleaning (keeps all existing snapshots)
npx storybook-visual-regression update --no-clean --include "MyComponent"
```

**Only create missing snapshots:**

```bash
npx storybook-visual-regression update --missing-only
```

**Run tests:**

```bash
# All stories
npx storybook-visual-regression test

# Filtered stories
npx storybook-visual-regression test --include "button*,card*" --exclude "**/wip"
npx storybook-visual-regression test --grep "MyComponent.*primary"
```

**Performance optimization:**

```bash
# Fast test run (for quick feedback)
npx storybook-visual-regression test \
  -w 16 \
  --final-settle 200 \
  --resource-settle 50 \
  --nav-timeout 8000

# Stable update run (for creating baselines)
npx storybook-visual-regression update \
  -w 8 \
  --wait-timeout 60000 \
  --final-settle 1000 \
  --resource-settle 200

# For stories with slow-loading resources
npx storybook-visual-regression test \
  --nav-timeout 30000 \
  --resource-settle 300
```

### Outputs

- Screenshots: `<output>/snapshots/<storyId>.png`
- Results: `<output>/results/` (reserved for integrations/exports)
- Console summary with total, passed, failed, total elapsed time, and per‑story timings

### Results cleanup (when using quiet reporter)

If you run with `--quiet`, the built-in reporter performs cleanup as tests run:

- Passed tests: their attachments are deleted and empty folders are pruned under `<output>/results`
- Failed tests: non-diff attachments are removed; only diff images are kept

This keeps your results directory focused on the actionable artifacts.

### Story discovery

By default the tool fetches `index.json` from the running dev server at `<url>:<port>`. If the dev server is unavailable, it falls back to `./storybook-static/index.json`. Ensure your CI either runs the Storybook server or builds the static export before running tests.

### Determinism

- Animations can be disabled to reduce flakiness (`--disable-animations` by default)
- Timezone/locale can be specified
- A frozen time can be provided via `--frozen-time` to stabilize date rendering

### CI usage

#### Cross-Platform Font Rendering

**Important**: If you create snapshots on macOS but run tests on Linux (GitHub Actions), you may encounter font rendering differences. Use these configurations:

**Option 1: Use CI-specific config file**

Create `svr.ci.config.js`:

```javascript
export default {
  // Allow more pixel differences for font rendering
  threshold: 0.5,
  maxDiffPixels: 200,

  // Use deterministic settings
  frozenTime: '2024-01-15T10:30:00.000Z',
  timezone: 'UTC',
  locale: 'en-US',

  // Ensure consistent rendering
  disableAnimations: true,
  waitForNetworkIdle: true,
  contentStabilizationTime: 1000,

  // CI optimizations
  workers: 4,
  timeout: 60000,
  serverTimeout: 180000,
  maxFailures: 0,
};
```

**Option 2: Use font-tolerant config**

Create `svr.font-tolerant.config.js`:

```javascript
export default {
  // More precise font rendering tolerance
  threshold: 0.1,
  maxDiffPixels: 100, // Allow up to 100 pixels difference

  // Font-specific settings
  frozenTime: '2024-01-15T10:30:00.000Z',
  timezone: 'UTC',
  locale: 'en-US',
  disableAnimations: true,
  waitForNetworkIdle: true,
  contentStabilizationTime: 1000,
};
```

#### GitHub Actions Example

```yaml
name: Visual Regression
on: [pull_request]
jobs:
  visual-regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install chromium --with-deps
      - run: npm run build-storybook
      - run: |
          npx storybook-visual-regression test \
            --command "npm run storybook" \
            --url http://localhost \
            --port 9009 \
            --workers 4 \
            --threshold 0.5 \
            --max-diff-pixels 200 \
            --timezone UTC \
            --locale en-US \
            --disable-animations \
            --wait-until networkidle \
            --final-settle 1000 \
            --resource-settle 300 \
            --max-failures 0
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: visual-regression-results
          path: visual-regression/results/
          retention-days: 7
```

#### Command Line Options for Font Rendering

You can also configure font rendering tolerance directly via CLI options:

```bash
# High tolerance for CI environments
npx storybook-visual-regression test \
  --threshold 0.5 \
  --max-diff-pixels 200 \
  --timezone UTC \
  --locale en-US

# More precise tolerance for font differences
npx storybook-visual-regression test \
  --threshold 0.1 \
  --max-diff-pixels 100 \
  --timezone UTC \
  --locale en-US
```

### Troubleshooting

- **"Unable to discover stories"** → Ensure Storybook is running on `--url/--port` or build static files to `storybook-static/`.
- **Playwright not installed** → Add `@playwright/test` and run `npx storybook-visual-regression install-browsers`.
- **Browser installation fails** → The tool will exit with an error code. Ensure you have sufficient permissions and network access.
- **Flaky screenshots** → Use `--disable-animations`, increase `--final-settle`, or set `--frozen-time` and a fixed `--timezone`/`--locale`.
- **Test timeouts** → The tool auto-calculates test timeout based on all wait operations. If stories still timeout, increase `--nav-timeout` and `--wait-timeout`.
- **Stories load instantly in browser but timeout in tests** → The tool automatically handles this by using resource-based loading detection. If needed, increase `--resource-settle` to give resources more time to finish.
- **Fonts not loading properly** → Increase `--nav-timeout` or `--resource-settle` to give fonts more time. The tool explicitly waits for fonts using `document.fonts.ready`.
- **Font rendering differences between macOS and Linux** → Use `--threshold 0.5` and `--max-diff-pixels 200` for CI environments. Create snapshots on the same OS as your CI, or use the provided CI config files.
- **Exiting early** → Increase or disable `--max-failures` (set `<= 0`).
- **Storybook server stops during tests** → Use `--max-failures 0` to prevent early termination, or check for port conflicts.
- **Verbose failure output** → Use `--quiet` flag to suppress detailed error messages and see only test progress.
- **Old snapshots not deleted on update** → By default, `update` command cleans snapshots. Use `--no-clean` to preserve existing snapshots.

### License

MIT
