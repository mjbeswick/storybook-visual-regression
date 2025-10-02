## storybook-visual-regression

Visual regression testing for Storybook using Playwright. Automatically discovers stories from a running Storybook dev server or a built `storybook-static` folder, captures deterministic screenshots, and reports pass/fail with a simple list-style output. Includes fast parallel execution, retries, fail-fast, and optional Playwright reporter integration.

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
  --command "npm run dev:ui" \
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

# or grep-style single pattern
npx storybook-visual-regression test --grep button--primary
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
- `-c, --command <cmd>`: command to start Storybook (default `npm run dev:ui`)
- `--server-timeout <ms>`: wait for server (default `60000`)
- `-o, --output <dir>`: results root (default `visual-regression`)
  - Snapshots: `<output>/snapshots`
  - Results: `<output>/results`
- `-b, --browser <name>`: `chromium|firefox|webkit` (default `chromium`)
- `--headless` / `--headed`: browser mode (default headless)
- `-t, --threshold <0-1>`: visual diff threshold (default `0.2`)
- `--viewport <WxH>`: default viewport (default `1024x768`)
- `--workers <n>`: parallel workers (default `12`)
- `--retries <n>`: retries on failure (default `2`)
- `--timeout <ms>`: test timeout (default `30000`)
- `--action-timeout <ms>`: action timeout (default `5000`)
- `--navigation-timeout <ms>`: navigation timeout (default `10000`)
- `--frozen-time <iso>`: deterministic time (default `2024-01-15T10:30:00.000Z`)
- `--timezone <tz>`: e.g. `Europe/London` (default `Europe/London`)
- `--locale <bcp47>`: e.g. `en-GB` (default `en-GB`)
- `--include <patterns>`: include ids/titles (comma‑separated)
- `--exclude <patterns>`: exclude ids/titles (comma‑separated)
- `--grep <pattern>`: run stories matching pattern
- `--disable-animations` / `--enable-animations`: control animations (default disabled)
- `--wait-network-idle` / `--no-wait-network-idle`: wait strategy (default wait)
- `--content-stabilization` / `--no-content-stabilization` (default enabled)
- `--max-failures <n>`: stop early after N failures (default `3`, <=0 disables)
- `--use-playwright-reporter`: run via Playwright Test and pipe its reporter
- `--reporter <name>`: reporter when piping via Playwright (`list|dot|json|html`) (default `line`)

### Example workflows

- Run locally with a dev server you start yourself:

  ```bash
  npm run dev:ui &
  npx storybook-visual-regression test --url http://localhost --port 9009
  ```

- Let the tool start Storybook for you:

  ```bash
  npx storybook-visual-regression test --command "npm run dev:ui" --server-timeout 90000
  ```

- Update only stories matching a pattern:

  ```bash
  npx storybook-visual-regression update --grep button
  ```

- Use Playwright’s reporter (same discovery, delegated execution):
  ```bash
  npx storybook-visual-regression test --use-playwright-reporter --reporter list
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
            --command "npm run dev:ui" \
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

### License

MIT
