# Addon Architecture & Limitations

## What This Addon Is

This is a **UI demonstration** and **proof-of-concept** for integrating visual regression testing into Storybook. It shows:

1. ✅ How to create a Storybook addon with a panel and toolbar
2. ✅ How to structure the UI for visual regression testing
3. ✅ The communication patterns between manager and preview
4. ✅ Component architecture for displaying test results and diffs

## The Fundamental Limitation

**Storybook addons run in the browser, but the visual regression CLI tool is a Node.js application.**

```
┌─────────────────────────────────┐
│   Browser (Storybook)           │
│                                 │
│  ┌─────────────┐                │
│  │   Addon UI  │  ← Runs here  │
│  │  (manager)  │                │
│  └─────────────┘                │
│                                 │
│  ┌─────────────┐                │
│  │  Preview    │  ← Also here  │
│  │  (stories)  │                │
│  └─────────────┘                │
└─────────────────────────────────┘
         ❌ CANNOT DO ❌
         spawn('storybook-visual-regression')
         ❌ Browser can't run Node processes
```

## What Happens When You Use It

### Current Behavior (Demo Mode)

1. User clicks "Test Current Story"
2. Addon shows "Running..."
3. After 1 second, shows an error message explaining the limitation
4. Message tells user to run CLI tool manually

### Expected Message

```
This is a demo/example addon. To run actual tests, you need to:

1. Run tests via CLI: storybook-visual-regression test --json
2. Or implement a backend service that spawns the CLI tool
3. Or use WebSockets to communicate with a test runner service

The preview iframe runs in the browser and cannot spawn Node.js processes.
```

## Making It Production-Ready

To make this addon fully functional, you need to build a **backend service**. Here are three approaches:

### Approach 1: WebSocket Service

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  Storybook   │  WebSocket  │   Backend    │  spawn   │  CLI Tool    │
│  Addon       │◄────────────┤   Service    │────────►│  Playwright  │
│  (Browser)   │         │  (Node.js)   │         │  Tests       │
└──────────────┘         └──────────────┘         └──────────────┘
```

**Implementation:**

```javascript
// backend/server.js
const WebSocket = require('ws');
const { spawn } = require('child_process');

const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    const { action, storyId } = JSON.parse(message);

    if (action === 'test') {
      const child = spawn('storybook-visual-regression', ['test', '--grep', storyId, '--json']);

      child.stdout.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'output', data: data.toString() }));
      });

      child.on('close', (code) => {
        ws.send(JSON.stringify({ type: 'complete', code }));
      });
    }
  });
});
```

```typescript
// addon/src/preview.ts - Updated
const ws = new WebSocket('ws://localhost:8080');

ws.on('message', (data) => {
  const result = JSON.parse(data);
  channel.emit(EVENTS.TEST_COMPLETED, result);
});

channel.on(EVENTS.RUN_TEST, ({ storyId }) => {
  ws.send(JSON.stringify({ action: 'test', storyId }));
});
```

### Approach 2: HTTP/SSE Service

```javascript
// backend/server.js
const express = require('express');
const app = express();

app.post('/test', async (req, res) => {
  const { storyId } = req.body;

  // Set up Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');

  const child = spawn('storybook-visual-regression', ['test', '--grep', storyId, '--json']);

  child.stdout.on('data', (data) => {
    res.write(`data: ${data}\n\n`);
  });

  child.on('close', () => {
    res.end();
  });
});

app.listen(3001);
```

### Approach 3: Storybook Dev Server Plugin

Use Storybook's builder plugin system to inject a custom endpoint:

```javascript
// .storybook/main.js
module.exports = {
  addons: ['@storybook-visual-regression/addon'],

  async viteFinal(config) {
    config.plugins.push({
      name: 'visual-regression-api',
      configureServer(server) {
        server.middlewares.use('/api/visual-regression', (req, res) => {
          // Handle test requests
        });
      },
    });
    return config;
  },
};
```

## Simpler Alternative: CLI-First Workflow

Instead of trying to run tests from the browser, embrace a CLI-first workflow:

### 1. Run tests in terminal

```bash
storybook-visual-regression test --json > results.json
```

### 2. Addon reads results file

```typescript
// addon could periodically check for results.json
fetch('/visual-regression/results.json')
  .then((r) => r.json())
  .then((results) => displayResults(results));
```

### 3. User workflow

1. Make component changes
2. Run `npm run visual-regression` in terminal
3. View results in Storybook addon panel
4. If needed, run `npm run visual-regression:update`

## File Watching Approach

The addon could trigger tests via file system watching:

```typescript
// addon writes a "request file"
fetch('/api/request-test', {
  method: 'POST',
  body: JSON.stringify({ storyId: 'button--primary' }),
});

// Backend watches for request files and runs tests
const watcher = chokidar.watch('./test-requests/*.json');
watcher.on('add', (path) => {
  const request = JSON.parse(fs.readFileSync(path));
  runTest(request.storyId);
});
```

## Recommendation

For most teams, the **CLI-first workflow** is simplest:

1. Keep the addon as a **results viewer**
2. Run tests via CLI or CI/CD
3. Addon displays results from JSON files
4. No backend service needed

This is what tools like Chromatic do - the addon shows status, but tests run externally.

## Summary

- ✅ This addon **demonstrates the UI** beautifully
- ❌ It **cannot run tests** from the browser
- 🔧 You **need a backend** for full functionality
- 💡 Or use **CLI-first workflow** (simpler)
- 📚 Use this as a **reference** for your own implementation

The value of this addon is showing what's _possible_ and providing a starting point for your own production implementation.
