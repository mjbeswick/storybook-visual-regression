# Installation Guide

## Option 1: Local Development with npm link (Recommended for Testing)

### Step 1: Link the Addon

From the addon directory:

```bash
cd /Users/uk45006208/Projects/storybook-visual-regression/addon
npm link
```

### Step 2: Link in Your Storybook Project

```bash
cd /path/to/your/storybook-project
npm link storybook-visual-regression-addon
```

### Step 3: Register the Addon

Edit your `.storybook/main.js` or `.storybook/main.ts`:

```javascript
module.exports = {
  stories: ['../src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    'storybook-visual-regression-addon', // Add this line
  ],
};
```

### Step 4: Install Storybook Dependencies

The addon requires these peer dependencies:

```bash
npm install --save-dev \
  @storybook/blocks \
  @storybook/components \
  @storybook/icons \
  @storybook/manager-api \
  @storybook/preview-api \
  @storybook/theming
```

(Most Storybook projects already have these installed)

### Step 5: Start Storybook

```bash
npm run storybook
```

You should now see the "Visual Regression" panel at the bottom!

### Unlinking (When Done Testing)

```bash
cd /path/to/your/storybook-project
npm unlink storybook-visual-regression-addon

cd /Users/uk45006208/Projects/storybook-visual-regression/addon
npm unlink
```

---

## Option 2: Copy Files Directly

If npm link doesn't work, you can copy the built addon:

### Step 1: Build the Addon

```bash
cd /Users/uk45006208/Projects/storybook-visual-regression/addon
npm run build
```

### Step 2: Copy to Your Project

```bash
cp -r /Users/uk45006208/Projects/storybook-visual-regression/addon \
      /path/to/your/storybook-project/node_modules/storybook-visual-regression-addon
```

### Step 3: Register (Same as Option 1, Step 3)

---

## Option 3: Use Local File Path

You can reference the addon by file path in your Storybook config:

### In `.storybook/main.js`:

```javascript
const path = require('path');

module.exports = {
  stories: ['../src/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    path.resolve('/Users/uk45006208/Projects/storybook-visual-regression/addon/dist/preset'),
  ],
};
```

---

## Option 4: Publish to npm (For Production Use)

### Step 1: Update Package Info

Edit `addon/package.json`:

- Change the package name if needed
- Update version, author, repository, etc.

### Step 2: Build

```bash
cd addon
npm run build
```

### Step 3: Publish

```bash
npm publish --access public
```

### Step 4: Install in Projects

```bash
npm install --save-dev storybook-visual-regression-addon
```

Then register in `.storybook/main.js` as shown above.

---

## Troubleshooting

### "Module not found" error

Make sure you've built the addon:

```bash
cd addon
npm run build
```

### Addon doesn't appear in Storybook

1. Check the browser console for errors
2. Verify the addon is listed in `.storybook/main.js`
3. Restart Storybook after adding the addon
4. Check that peer dependencies are installed

### TypeScript errors

If using TypeScript, you may need to add type declarations:

```typescript
// storybook.d.ts
declare module 'storybook-visual-regression-addon';
```

### Icons not showing

Install `@storybook/icons`:

```bash
npm install --save-dev @storybook/icons
```

---

## Verifying Installation

Once installed and Storybook is running:

1. Open Storybook in your browser
2. Look for a "Visual Regression" tab/panel at the bottom
3. Look for play (▶️) and sync (🔄) icons in the toolbar
4. Select any story and click "Test Current Story"

If you see these UI elements, the addon is installed correctly!
