#!/bin/bash
# Script to rebuild and reload the addon

set -e

echo "🔨 Rebuilding addon..."
npm run build

echo ""
echo "✅ Addon rebuilt successfully!"
echo ""
echo "📝 Next steps:"
echo "   1. Stop your Storybook (Ctrl+C in the terminal)"
echo "   2. Restart Storybook: npm run storybook"
echo "   3. Hard reload browser: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows/Linux)"
echo ""
echo "If that doesn't work, recreate the npm link:"
echo "   cd $(pwd)"
echo "   npm link"
echo "   cd <your-project>"
echo "   npm unlink @storybook-visual-regression/addon"
echo "   npm link @storybook-visual-regression/addon"

