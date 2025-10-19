# Changelog

## [0.2.0] - 2025-01-17

### ✨ Major Update: Fully Functional!

#### Added

- **Built-in API Server**: The addon now starts an HTTP server (port 6007) via the Storybook preset
- **Real Test Execution**: Tests now actually run when you click the buttons!
- **Server-Sent Events**: Real-time streaming of test output from CLI to UI
- **Full CLI Integration**: Spawns `storybook-visual-regression` CLI tool from the API server

#### Changed

- Converted from UI demo/proof-of-concept to fully functional addon
- Updated documentation to reflect full functionality
- Removed mock/demo mode messaging

#### Technical Details

- `src/server.ts`: New HTTP server that handles test requests
- `src/preset.ts`: Now starts API server during Storybook initialization
- `src/preview.ts`: Updated to call real API instead of showing demo messages

### Architecture

```
┌─────────────────────────────────┐
│   Storybook Dev Server          │
│   (Node.js Process)             │
│                                 │
│  ┌───────────────────────┐      │
│  │  Visual Regression    │      │
│  │  API Server           │      │
│  │  (Port 6007)          │      │
│  │                       │      │
│  │  Spawns CLI Tool ───────────►│ storybook-visual-regression
│  └───────────────────────┘      │     (Playwright tests)
│                                 │
└─────────────────────────────────┘
         ▲
         │ HTTP/SSE
         │
┌─────────────────────────────────┐
│   Browser (Storybook UI)        │
│                                 │
│  ┌──────────────┐               │
│  │ Addon Panel  │               │
│  │ & Toolbar    │               │
│  └──────────────┘               │
└─────────────────────────────────┘
```

## [0.1.0] - 2025-01-16

### Initial Release

- Basic UI components (panel and toolbar)
- Event handling architecture
- Demo mode showing intended functionality
- Documentation and examples
