# Quick Start - Storybook Visual Regression Addon

This guide will help you get the addon running in under 5 minutes.

## Prerequisites

- Node.js 16+ installed
- A Storybook project (v7 or v8)
- `storybook-visual-regression` CLI tool installed

## Installation Steps

### 1. Install the Addon

```bash
npm install --save-dev @storybook-visual-regression/addon
```

### 2. Register in Storybook

Edit `.storybook/main.js`:

```javascript
module.exports = {
  stories: ['../src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    // Add this line:
    '@storybook-visual-regression/addon',
  ],
};
```

### 3. Install Playwright

```bash
npx playwright install chromium
```

### 4. Start Storybook

```bash
npm run storybook
```

## Using the Addon

### First Test

1. **Open Storybook** in your browser (usually `http://localhost:6006`)

2. **Select a story** from the sidebar

3. **Look for the new Visual Regression panel** at the bottom of the screen

4. **Click "Test Current Story"** button

5. **Wait for the test to complete** - this creates a baseline snapshot

6. **See the result** - should show ✅ Passed

### Making Changes

1. **Edit your component** - change some CSS or content

2. **Click "Test Current Story"** again

3. **See the diff** - the addon shows:
   - Expected image (baseline)
   - Actual image (current)
   - Diff image (highlighted changes)

4. **Update or revert:**
   - If the change is intentional → click **"Update Baseline"**
   - If the change is a bug → fix your code and test again

## Toolbar Shortcuts

- **▶️ Play button** - Test current story
- **🔄 Sync button** - Test all stories

## Tips

### Speed Up Tests

Test all stories at once to benefit from parallel execution:

```
Click "Test All Stories" button
```

### Filter Tests

Use the CLI directly for more control:

```bash
# Test only Button component stories
storybook-visual-regression test --grep "Button" --json

# Test all except experimental stories
storybook-visual-regression test --exclude "Experimental" --json
```

### Configure Timeouts

For slow-loading stories, increase timeouts:

```bash
# In your terminal, not in the addon
storybook-visual-regression test \
  --nav-timeout 30000 \
  --wait-timeout 30000 \
  --json
```

## File Structure

After running tests, you'll see:

```
visual-regression/
├── snapshots/              # Baseline images
│   ├── Button/
│   │   ├── Primary.png
│   │   └── Secondary.png
│   └── Card/
│       └── Default.png
└── results/                # Test results and diffs
    ├── test-results.json   # JSON output
    └── test-results/       # Failed test artifacts
```

## Troubleshooting

### Addon panel is blank

- Open browser DevTools → Console tab
- Look for error messages
- Common issue: CLI tool not installed

### Tests are slow

- First run is always slower (creates baselines)
- Subsequent runs are faster
- Use "Test All Stories" for better parallelization

### Images don't load

- Check browser console for `file://` URL errors
- This is a known limitation with local file access
- Workaround: Use absolute paths for output directory

### CLI not found

Install the CLI tool:

```bash
npm install --save-dev storybook-visual-regression
```

Or globally:

```bash
npm install -g storybook-visual-regression
```

## Next Steps

- Read the full [README.md](./README.md) for advanced features
- Check out the [CLI documentation](../README.md) for more options
- Customize the addon for your workflow

## Example Workflow

### Daily Development

1. Pull latest code
2. Start Storybook
3. Make component changes
4. Test affected stories
5. Review diffs
6. Update baselines if intentional
7. Commit changes + updated snapshots

### Before PR

1. Click "Test All Stories"
2. Review any failures
3. Update baselines if needed
4. Commit all snapshots
5. Push to CI (CI will run tests again)

### In Code Review

1. Reviewer checks snapshot changes in git diff
2. Verifies changes match PR description
3. Looks for unintended visual regressions
4. Approves or requests changes

## Getting Help

- **Bug reports**: Open an issue on GitHub
- **Questions**: Check the README.md
- **Feature requests**: Open a discussion

Happy testing! 🎉
