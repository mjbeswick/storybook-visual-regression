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

- 🎯 **Run tests directly from Storybook** - Click toolbar button to test current story
- 🔄 **Test all stories** - Run visual regression on your entire Storybook
- 📊 **Real-time results** - See test status update live in the panel
- ✅ **Update baselines** - One-click baseline updates when changes are intentional
- 🎨 **Beautiful UI** - Seamlessly integrated panel and toolbar
- ⚡ **Built-in API server** - No separate backend needed!
- 📡 **Server-Sent Events** - Real-time streaming of test output

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

### Architecture

The addon consists of three main parts:

1. **Manager** (`manager.tsx`) - Runs in the Storybook UI, provides the panel and toolbar
2. **Preview** (`preview.ts`) - Runs in the story iframe, handles communication with the CLI tool
3. **CLI Integration** - Spawns the `storybook-visual-regression` CLI tool as a child process

### Communication Flow

```
User clicks "Test Story"
     ↓
Manager emits event
     ↓
Preview receives event
     ↓
Spawns CLI tool: storybook-visual-regression test --json --grep "Story Name"
     ↓
CLI runs Playwright test
     ↓
CLI outputs JSON results
     ↓
Preview parses results
     ↓
Preview emits result event
     ↓
Manager updates UI
```

### JSON Output

The addon uses the `--json` flag to get structured output from the CLI:

```json
{
  "status": "passed",
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
      "status": "passed",
      "duration": 2341,
      "attachments": []
    }
  ]
}
```

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

### Current Limitations

1. **Process Management** - The addon spawns CLI processes which may be slow for individual story tests
2. **Image Loading** - Local file URLs (`file://`) may not work in all browsers due to security restrictions
3. **Concurrent Tests** - Running multiple tests simultaneously may cause conflicts
4. **Update Mode** - Updating baselines requires running the full CLI tool

### Future Improvements

- **Server Mode** - Long-running server for faster individual tests
- **Image Proxy** - Server-side image serving for better browser compatibility
- **Queue Management** - Better handling of concurrent test requests
- **Incremental Updates** - Update individual baselines without full CLI run
- **Performance Metrics** - Track test execution times and bottlenecks

## Troubleshooting

### Tests Not Running

- Verify `storybook-visual-regression` is installed globally or in your project
- Check that Playwright browsers are installed: `npx playwright install`
- Look for error messages in the browser console

### Images Not Loading

- Check that the file paths in the JSON output are correct
- Try using an absolute path for the output directory: `--output /absolute/path`
- Some browsers block `file://` URLs - this is a known limitation

### Addon Not Appearing

- Verify the addon is registered in `.storybook/main.js`
- Restart Storybook after adding the addon
- Check for errors in the Storybook terminal output

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
