## storybook-visual-regression

A comprehensive visual regression testing tool for any Storybook project using Playwright. Automatically discovers stories from a running Storybook dev server or a built `storybook-static` folder, captures deterministic screenshots, and reports pass/fail with a simple list-style output. Includes fast parallel execution, retries, fail-fast, and optional Playwright reporter integration.

The tool automatically detects your Storybook configuration including:

- Port from package.json scripts
- Storybook command from package.json
- Viewport configurations from Storybook config files

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

### Quick start

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

Update snapshots after intentional UI changes:

```bash
npx storybook-visual-regression update
```

Filter stories by id/title substring (comma-separated):

```bash
npx storybook-visual-regression test --include button,card --exclude wip

# or regex pattern
npx storybook-visual-regression test --grep "button.*primary"
```

### What it does

- Discovers stories from `GET <url>:<port>/index.json` or falls back to `storybook-static/index.json`
- Launches the chosen Playwright browser and opens each story `iframe.html?id=<storyId>`
- Applies deterministic settings (optional frozen time/locale/timezone, disables animations if enabled)
- Captures screenshots and writes them to the configured snapshot folder
- Prints a concise pass/fail line per story and a summary; exits non‑zero if failures occur

### CLI

Commands:

- `test`: run visual regression tests
- `update`: update snapshots instead of comparing
- `install-browsers`: install Playwright browsers (`chromium|firefox|webkit|all`)

Common options (defaults shown):

- `-u, --url <url>`: Storybook server URL (default `http://localhost`)
- `-p, --port <port>`: Storybook port (default `9009`)
- `-c, --command <cmd>`: command to start Storybook (default `npm run storybook`)
- `--webserver-timeout <ms>`: wait for Storybook to boot (default `120000`)
- `-o, --output <dir>`: results root (default `visual-regression`)
  - Snapshots: `<output>/snapshots`
  - Results: `<output>/results`
- `-w, --workers <n>`: parallel workers (default `12`)
- `--retries <n>`: retries on failure (default `0`)
- `--max-failures <n>`: stop early after N failures (default `1`, <=0 disables)
- `--timezone <tz>`: e.g. `Europe/London` (default `Europe/London`)
- `--locale <bcp47>`: e.g. `en-GB` (default `en-GB`)
- `--reporter <reporter>`: Playwright reporter (list|line|dot|json|junit) (default `list`)
- `--quiet`: suppress verbose failure output, show only test progress
- `--debug`: print environment information before running Playwright
- `--include <patterns>`: include stories matching patterns (comma-separated)
- `--exclude <patterns>`: exclude stories matching patterns (comma-separated)
- `--grep <pattern>`: filter stories by regex pattern

### Example workflows

Create snapshots for first time:

```bash
npx storybook-visual-regression update --command "npm run storybook" --url http://localhost:9009
```

or update snapshots after intentional UI changes:

```bash
npx storybook-visual-regression test --command "npm run storybook" --url http://localhost:9009 --grep "MyComponent"
```

Run all stories:

```bash
npx storybook-visual-regression test --command "npm run storybook" --url http://localhost:9009
```

Run all stories with a specific grep pattern:

```bash
npx storybook-visual-regression test --command "npm run storybook" --url http://localhost:9009 --grep "MyComponent"
```

### Outputs

- Screenshots: `<output>/snapshots/<storyId>.png`
- Results: `<output>/results/` (reserved for integrations/exports)
- Console summary with total, passed, failed, and per‑story timings

### Story discovery

By default the tool fetches `index.json` from the running dev server at `<url>:<port>`. If the dev server is unavailable, it falls back to `./storybook-static/index.json`. Ensure your CI either runs the Storybook server or builds the static export before running tests.

### Determinism

- Animations can be disabled to reduce flakiness (`--disable-animations` by default)
- Timezone/locale can be specified
- A frozen time can be provided via `--frozen-time` to stabilize date rendering

### CI usage

GitHub Actions example:

```yaml
name: Visual Regression
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx storybook-visual-regression install-browsers --browser chromium
      - run: |
          npx storybook-visual-regression test \
            --command "npm run storybook" \
            --url http://localhost \
            --port 9009 \
            --workers 4 \
            --max-failures 1
```

### Troubleshooting

- "Unable to discover stories" → Ensure Storybook is running on `--url/--port` or build static files to `storybook-static/`.
- Playwright not installed → Add `@playwright/test` and run `npx storybook-visual-regression install-browsers`.
- Flaky screenshots → Use `--disable-animations`, `--wait-network-idle`, increase `--timeout`, or set `--frozen-time` and a fixed `--timezone`/`--locale`.
- Exiting early → Increase or disable `--max-failures` (set `<= 0`).
- Storybook server stops during tests → Use `--max-failures 0` to prevent early termination, or check for port conflicts.
- Verbose failure output → Use `--quiet` flag to suppress detailed error messages and see only test progress.

### License

MIT
