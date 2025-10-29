# Storybook Visual Regression

A comprehensive visual regression testing tool for any Storybook project. This monorepo contains two packages:

1. **[@storybook-visual-regression/cli](./cli/)** - Command-line tool for running visual regression tests
2. **[@storybook-visual-regression/addon](./addon/)** - Storybook addon with built-in UI for visual regression testing

## Packages

### CLI Tool

The CLI tool (`@storybook-visual-regression/cli`) provides command-line testing capabilities:

- **Automated testing** - Run visual regression tests from the command line
- **CI/CD integration** - Perfect for continuous integration pipelines
- **Configuration options** - Flexible configuration via config files or CLI flags
- **Cross-platform** - Works on macOS, Windows, and Linux
- **Docker support** - Consistent font rendering across platforms

**Quick Start:**

```bash
npm install --save-dev @storybook-visual-regression/cli
npx storybook-visual-regression test
```

📖 **[See CLI documentation →](./cli/README.md)**

### Storybook Addon

The addon (`@storybook-visual-regression/addon`) provides an integrated testing experience within Storybook:

- **One-click testing** - Test individual stories from the Storybook UI
- **Batch testing** - Run tests for all stories with progress tracking
- **Real-time results** - See test results immediately in the addon panel
- **Visual diff display** - Side-by-side comparison of expected vs actual screenshots
- **Built-in API server** - No external dependencies required

**Quick Start:**

```bash
npm install --save-dev @storybook-visual-regression/addon
```

📖 **[See Addon documentation →](./addon/README.md)**

## Features

### 🎯 Core Capabilities

- **Visual comparison** - Pixel-perfect screenshot comparison using odiff
- **Storybook integration** - Automatic discovery of all stories in your Storybook
- **Smart stabilization** - Waits for DOM mutations, animations, and network activity to complete
- **Flexible configuration** - JSON, JavaScript, or TypeScript config files
- **Parallel execution** - Run multiple tests simultaneously for faster results
- **Multiple browsers** - Support for Chromium, Firefox, and WebKit
- **Baseline management** - Easy update and management of visual baselines

### 🚀 Advanced Features

- **Cross-platform consistency** - Docker support for identical font rendering
- **Custom timeouts** - Fine-tune timeouts for different story types
- **Story filtering** - Include/exclude stories by pattern matching
- **Failure handling** - Retry logic and graceful error handling
- **Progress tracking** - Real-time progress updates and time estimates
- **JSON output** - Machine-readable test results for CI/CD integration

## Installation

### CLI Tool

```bash
npm install --save-dev @storybook-visual-regression/cli
```

### Addon

```bash
npm install --save-dev @storybook-visual-regression/addon
```

### Prerequisites

Both packages require:

- **Node.js** >= 20.0.0
- **Playwright browsers** installed (Chromium recommended)
- **Storybook** project

Install Playwright browsers:

```bash
npx playwright install chromium
```

## Quick Start

### Using the CLI

1. **Install the CLI:**

   ```bash
   npm install --save-dev @storybook-visual-regression/cli
   ```

2. **Initialize configuration (optional):**

   ```bash
   npx storybook-visual-regression init
   ```

3. **Run tests:**
   ```bash
   npx storybook-visual-regression test
   ```

### Using the Addon

1. **Install the addon:**

   ```bash
   npm install --save-dev @storybook-visual-regression/addon
   ```

2. **Register in `.storybook/main.js`:**

   ```javascript
   module.exports = {
     addons: ['@storybook-visual-regression/addon'],
   };
   ```

3. **Start Storybook:**

   ```bash
   npm run storybook
   ```

4. **Click the play button (▶️) in the toolbar** to test stories from the UI!

## Configuration

Both packages support configuration via:

- **Config files**: `svr.config.js`, `svr.config.ts`, or `.svrrc.json`
- **CLI flags**: Override config values from the command line
- **Environment variables**: Set default values via environment

See the individual package documentation for detailed configuration options:

- [CLI Configuration](./cli/README.md#configuration)
- [Addon Configuration](./addon/README.md#configuration)

## Cross-Platform Font Rendering

If you're running visual regression tests in CI/CD (Linux) but developing locally on macOS or Windows, you may encounter font rendering differences.

**Solution**: Use Docker for consistent rendering across all platforms. See [CROSS-PLATFORM-FONTS.md](./CROSS-PLATFORM-FONTS.md) for details.

## Project Structure

```
storybook-visual-regression/
├── cli/                    # CLI tool package
│   ├── src/               # Source code
│   ├── dist/              # Compiled output
│   └── README.md          # CLI documentation
├── addon/                 # Storybook addon package
│   ├── src/               # Source code
│   ├── dist/              # Compiled output
│   └── README.md          # Addon documentation
├── demo/                  # Demo Storybook project
├── Dockerfile            # Docker image for cross-platform testing
└── README.md             # This file
```

## Development

This is a monorepo managed with npm workspaces.

### Building

Build all packages:

```bash
npm run build
```

Build individual packages:

```bash
npm run build --workspace cli
npm run build --workspace addon
```

### Testing

Run tests for all packages:

```bash
npm test
```

### Publishing

Publish CLI:

```bash
npm run publish:cli
```

Publish Addon:

```bash
npm run publish:addon
```

## License

MIT

## Author

Michael Beswick <mjbeswick@gmail.com>

## Repository

- **GitHub**: https://github.com/mjbeswick/storybook-visual-regression
- **Issues**: https://github.com/mjbeswick/storybook-visual-regression/issues

## Related Documentation

- [CLI Documentation](./cli/README.md)
- [Addon Documentation](./addon/README.md)
