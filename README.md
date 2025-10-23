# Storybook Visual Regression

A comprehensive visual regression testing tool for any Storybook project.

## Monorepo Structure

This repository is organized as a monorepo with two main packages:

- **`./cli`** - The CLI tool (`@storybook-visual-regression/cli`)
- **`./addon`** - The Storybook addon (`@storybook-visual-regression/addon`)

## Quick Start

### CLI Tool

```bash
# Install globally
npm install -g @storybook-visual-regression/cli

# Or use with npx
npx @storybook-visual-regression/cli test -c "npm run storybook"
```

### Storybook Addon

```bash
# Install the addon
npm install @storybook-visual-regression/addon

# Add to your Storybook configuration
```

## Development

### Prerequisites

- Node.js >= 20.0.0
- npm

### Setup

```bash
# Install dependencies for all packages
npm install

# Build all packages
npm run build

# Run tests for all packages
npm run test

# Run linting for all packages
npm run lint
```

### Package-specific Commands

```bash
# CLI package
cd cli
npm run build
npm run test
npm run lint

# Addon package
cd addon
npm run build
npm run dev
```

### Publishing

```bash
# Publish CLI package
npm run publish:cli

# Publish addon package
npm run publish:addon
```

## Packages

### CLI Package (`./cli`)

The main CLI tool for running visual regression tests on Storybook stories.

- **Package**: `@storybook-visual-regression/cli`
- **Entry point**: `cli/dist/cli/index.js`
- **Binary**: `storybook-visual-regression`

### Addon Package (`./addon`)

A Storybook addon that provides a UI for running visual regression tests directly from Storybook.

- **Package**: `@storybook-visual-regression/addon`
- **Entry point**: `addon/dist/preset.js`

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm run test`
5. Run linting: `npm run lint`
6. Submit a pull request

## License

MIT