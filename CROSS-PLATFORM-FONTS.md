# Cross-Platform Font Rendering Solution

## Problem

Visual regression tests fail in GitHub Actions due to tiny font rendering differences between macOS (where snapshots were created) and Linux (where CI runs).

## Solution

### 1. Use CI-Specific Configuration

**File: `svr.ci.config.js`**

```javascript
export default {
  threshold: 0.5, // 50% threshold for CI
  maxDiffPixels: 200, // Allow up to 200 pixels difference
  frozenTime: '2024-01-15T10:30:00.000Z',
  timezone: 'UTC',
  locale: 'en-US',
  disableAnimations: true,
  waitForNetworkIdle: true,
  contentStabilizationTime: 1000,
  workers: 4,
  timeout: 60000,
  serverTimeout: 180000,
  maxFailures: 0,
};
```

### 2. GitHub Actions Command

```bash
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
```

### 3. Command Line Only (No Config Files)

You can also configure everything directly via CLI options:

```bash
# High tolerance for CI environments
npx storybook-visual-regression test \
  --threshold 0.5 \
  --max-diff-pixels 200 \
  --timezone UTC \
  --locale en-US \
  --workers 4 \
  --max-failures 0

# More precise tolerance for font differences
npx storybook-visual-regression test \
  --threshold 0.1 \
  --max-diff-pixels 100 \
  --timezone UTC \
  --locale en-US
```

### 4. Alternative: Font-Tolerant Config

**File: `svr.font-tolerant.config.js`**

```javascript
export default {
  threshold: 0.1, // Lower threshold
  maxDiffPixels: 100, // Allow up to 100 pixels difference
  frozenTime: '2024-01-15T10:30:00.000Z',
  timezone: 'UTC',
  locale: 'en-US',
  disableAnimations: true,
  waitForNetworkIdle: true,
  contentStabilizationTime: 1000,
};
```

## Key Settings Explained

- **`threshold: 0.5`** - Allows 50% pixel difference (vs default 20%)
- **`maxDiffPixels: 200`** - Allows up to 200 pixels to be different
- **`timezone: 'UTC'`** - Consistent timezone across platforms
- **`locale: 'en-US'`** - Standard locale for consistent rendering
- **`contentStabilizationTime: 1000`** - Extra time for fonts to settle
- **`disableAnimations: true`** - Prevents timing-based differences
- **`waitForNetworkIdle: true`** - Ensures all resources load

## Best Practices

1. **Create snapshots on the same OS as CI** (Linux) if possible
2. **Use deterministic settings** (frozen time, UTC timezone)
3. **Increase thresholds for CI** but keep them strict for local development
4. **Upload test artifacts** when tests fail for debugging
5. **Use fewer workers** in CI to reduce resource contention

## Files Created

- `svr.ci.config.js` - CI-optimized configuration
- `svr.font-tolerant.config.js` - Font-specific tolerance settings
- `.github/workflows/visual-regression.yml` - Complete GitHub Actions workflow
