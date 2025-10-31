import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { spawn, ChildProcess, exec } from 'child_process';
import { parse as parseUrl } from 'url';
import { readdir, stat, readFile, mkdir } from 'fs/promises';
import { watch as watchFs } from 'fs';
import { join, relative, dirname } from 'path';
import { existsSync } from 'fs';
import type { Dirent } from 'fs';
// Import JSON-RPC types inline since we can't import from CLI package
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

class JsonRpcClient {
  private process: any = null;
  private nextId = 1;
  private pendingRequests = new Map<number | string, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timeout: NodeJS.Timeout;
  }>();
  private listeners = new Map<string, Set<(params: any) => void>>();

  constructor(private cliCommand: string = 'npx @storybook-visual-regression/cli') {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      this.process = spawn(this.cliCommand, ['--json-rpc'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      });

      if (!this.process.stdout || !this.process.stderr || !this.process.stdin) {
        reject(new Error('Failed to create process streams'));
        return;
      }

      let stdoutBuffer = '';
      this.process.stdout.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const messages = this.parseJsonRpcMessages(stdoutBuffer);
        if (messages.length > 0) {
          stdoutBuffer = messages.pop()?.remaining || '';
          for (const message of messages) {
            this.handleMessage(message.message);
          }
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        // Forward stderr as log events
        this.emit('log', { level: 'error', message: data.toString().trim() });
      });

      this.process.on('exit', (code: number | null, signal: string | null) => {
        this.emit('exit', { code, signal });
        this.cleanup();
      });

      this.process.on('error', (error: Error) => {
        this.emit('error', { error: error.message });
        this.cleanup();
        reject(error);
      });

      // Wait for ready notification
      this.once('ready', () => {
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);
        this.process?.once?.('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.cleanup();
  }

  async request<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.sendMessage(request);
    });
  }

  notify(method: string, params?: any): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.sendMessage(notification);
  }

  on(event: string, listener: (params: any) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  once(event: string, listener: (params: any) => void): void {
    const onceListener = (params: any) => {
      this.off(event, onceListener);
      listener(params);
    };
    this.on(event, onceListener);
  }

  off(event: string, listener: (params: any) => void): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  async run(params: any): Promise<any> {
    return this.request('run', params);
  }

  async cancel(): Promise<any> {
    return this.request('cancel');
  }

  private sendMessage(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('CLI process not started');
    }

    const json = JSON.stringify(message) + '\n';
    this.process.stdin.write(json);
  }

  private handleMessage(message: any): void {
    if (message.jsonrpc !== '2.0') {
      return;
    }

    if ('id' in message && message.id !== null) {
      // This is a response
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timeout);

        if ('error' in message) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else {
      // This is a notification
      this.emit(message.method, message.params);
    }
  }

  private emit(event: string, params: any): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(params);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      }
    }
  }

  private parseJsonRpcMessages(buffer: string): Array<{ message: any; remaining: string }> {
    const messages: Array<{ message: any; remaining: string }> = [];
    let remaining = buffer;

    while (true) {
      const newlineIndex = remaining.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = remaining.substring(0, newlineIndex);
      remaining = remaining.substring(newlineIndex + 1);

      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          messages.push({ message, remaining });
        } catch (error) {
          // Invalid JSON - ignore
        }
      }
    }

    return messages;
  }

  private cleanup(): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(new Error('Process terminated'));
    }
    this.listeners.clear();
    this.process = null;
  }
}

type TestRequest = {
  action: 'test' | 'update' | 'update-baseline' | 'test-all';
  storyId?: string;
  storyName?: string;
};

type FailedResult = {
  storyId: string;
  storyName: string;
  diffImagePath?: string;
  actualImagePath?: string;
  expectedImagePath?: string;
  errorImagePath?: string;
  errorType?: 'screenshot_mismatch' | 'loading_failure' | 'network_error' | 'other_error';
};

// Storybook index types
type StorybookIndexEntry = {
  type: 'story';
  id: string;
  name: string;
  title: string;
  importPath: string;
};

type StorybookIndex = {
  v: number;
  entries: Record<string, StorybookIndexEntry>;
};

// Extract story metadata from index.json (same logic as CLI)
function extractStoryMetadata(index: StorybookIndex): {
  storySnapshotPaths: Record<string, string>;
} {
  const entries = index.entries || {};
  const storySnapshotPaths: Record<string, string> = {};

  function sanitizePathSegment(segment: string): string {
    return segment
      .replace(/[<>:"|?*\\/]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/\.\./g, '-')
      .replace(/^[\s.-]+|[\s.-]+$/g, '')
      .replace(/-+/g, '-')
      .trim();
  }

  for (const [id, entry] of Object.entries(entries)) {
    if (entry.type === 'story') {
      const displayName = entry.title ? `${entry.title} / ${entry.name}` : entry.name || id;
      const parts = displayName.split(' / ').map((part) => sanitizePathSegment(part));
      const fileName = parts.pop() || id;
      const dirPath = parts.length > 0 ? parts.join('/') : '';
      storySnapshotPaths[id] = dirPath ? `${dirPath}/${fileName}.png` : `${fileName}.png`;
    }
  }

  return { storySnapshotPaths };
}

// Load Storybook index.json to get story metadata
async function loadStorybookIndex(
  storybookUrl: string = 'http://localhost:6006',
): Promise<StorybookIndex | null> {
  try {
    const indexUrl = `${storybookUrl.replace(/\/$/, '')}/index.json`;
    const response = await fetch(indexUrl);
    if (!response.ok) {
      // Try fallback to static files
      try {
        const staticIndexPath = join(process.cwd(), 'storybook-static', 'index.json');
        if (existsSync(staticIndexPath)) {
          const data = await readFile(staticIndexPath, 'utf8');
          return JSON.parse(data) as StorybookIndex;
        }
      } catch {
        // Ignore static file errors
      }
      return null;
    }
    const data = await response.json();
    return data as StorybookIndex;
  } catch {
    // Try fallback to static files
    try {
      const staticIndexPath = join(process.cwd(), 'storybook-static', 'index.json');
      if (existsSync(staticIndexPath)) {
        const data = await readFile(staticIndexPath, 'utf8');
        return JSON.parse(data) as StorybookIndex;
      }
    } catch {
      // Ignore static file errors
    }
    return null;
  }
}

let server: Server | null = null;
let jsonRpcClient: JsonRpcClient | null = null;
const activeProcesses = new Map<
  string,
  {
    process: ChildProcess;
    command: string;
    startTime: number;
  }
>();

// Debounce mechanism to prevent multiple rapid stop requests
let stopRequestTimeout: NodeJS.Timeout | null = null;
let isStopInProgress = false; // Track active CLI processes with metadata

// Helper function to ensure visual-regression directory structure exists
async function ensureVisualRegressionDirs(): Promise<void> {
  const baseDir = join(process.cwd(), 'visual-regression');
  const resultsDir = join(baseDir, 'results');

  try {
    await mkdir(baseDir, { recursive: true });
    await mkdir(resultsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, that's fine
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      // ignore directory creation errors
    }
  }
}

export function startApiServer(
  port = 6007,
  cliCommand = 'npx @storybook-visual-regression/cli',
): Server {
  if (server) {
    return server;
  }

  // Ensure directories exist when server starts
  ensureVisualRegressionDirs().catch(() => {
    // ignore startup directory creation errors
  });

  // Initialize JSON-RPC client
  jsonRpcClient = new JsonRpcClient(cliCommand);
  jsonRpcClient.on('progress', (progress: any) => {
    // Forward progress events to any connected WebSocket/SSE clients
    // This could be enhanced with actual WebSocket support
  });
  jsonRpcClient.on('log', (logData: any) => {
    // Forward log events
  });
  jsonRpcClient.on('error', (error: any) => {
    console.error('[VR Addon] JSON-RPC error:', error);
  });

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Enable CORS for Storybook
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = parseUrl(req.url || '', true);
    const pathname = parsedUrl.pathname;

    // Health check endpoint
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'visual-regression-addon' }));
      return;
    }

    // Get existing failed test results endpoint
    if (pathname === '/get-failed-results' && req.method === 'GET') {
      try {
        const resultsDir = join(process.cwd(), 'visual-regression', 'results');
        const failedResults = await scanFailedResults(resultsDir);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(failedResults));
        return;
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to scan results directory' }));
        return;
      }
    }

    // Serve image files endpoint
    if (pathname?.startsWith('/image/') && req.method === 'GET') {
      try {
        // Extract the file path from the URL
        // URL format: /image/path/to/image.png
        const imagePath = decodeURIComponent(pathname.substring(7)); // Remove '/image/' prefix

        // Security check: ensure the path is within the visual-regression directory
        const resultsDir = join(process.cwd(), 'visual-regression');
        const fullPath = join(resultsDir, imagePath);

        // Check if the resolved path is within the results directory
        if (!fullPath.startsWith(resultsDir)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Access denied' }));
          return;
        }

        // Check if file exists
        const stats = await stat(fullPath);
        if (!stats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File not found' }));
          return;
        }

        // Read the image file
        const imageData = await readFile(fullPath);

        // Determine content type based on file extension
        const ext = fullPath.toLowerCase().split('.').pop();
        let contentType = 'application/octet-stream';
        if (ext === 'png') contentType = 'image/png';
        else if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
        else if (ext === 'gif') contentType = 'image/gif';
        else if (ext === 'webp') contentType = 'image/webp';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
        });
        res.end(imageData);
        return;
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to serve image' }));
        return;
      }
    }

    // Stop all running tests endpoint
    if (pathname === '/stop' && req.method === 'POST') {
      try {
        if (jsonRpcClient) {
          await jsonRpcClient.cancel();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            message: 'Stop request sent to CLI',
            stoppedCount: 1,
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            message: 'No active CLI process',
            stoppedCount: 0,
          }));
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to stop tests',
        }));
      }
      return;
    }

    // Watch failed results directory and stream updates (SSE)
    if (pathname === '/watch-failed' && req.method === 'GET') {
      try {
        const resultsDir = join(process.cwd(), 'visual-regression', 'results');

        // Establish SSE connection
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        // Only emit when data actually changes; debounce watcher noise
        let lastSignature = '';
        let scheduled = false;

        const buildSignature = (items: FailedResult[]): string => {
          const core = items
            .map((r) => ({
              id: r.storyId,
              d: r.diffImagePath,
              a: r.actualImagePath,
              e: r.expectedImagePath,
            }))
            .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
          return JSON.stringify(core);
        };

        const sendSnapshotIfChanged = async () => {
          try {
            const failedResults = await scanFailedResults(resultsDir);
            const sig = buildSignature(failedResults);
            if (sig !== lastSignature) {
              lastSignature = sig;
              res.write(
                `data: ${JSON.stringify({ type: 'failed-results', results: failedResults })}\n\n`,
              );
            }
          } catch {
            // Non-fatal; client stays connected
          }
        };

        // Send initial state
        await sendSnapshotIfChanged();

        // Start watcher - only if directory exists
        let watcher: ReturnType<typeof watchFs> | null = null;
        try {
          // Check if directory exists before watching
          await stat(resultsDir);
          watcher = watchFs(resultsDir, { recursive: true }, () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(async () => {
              scheduled = false;
              await sendSnapshotIfChanged();
            }, 200);
          });
        } catch {
          // Directory doesn't exist yet, that's okay - we'll create it when needed
        }

        // Cleanup on client disconnect
        req.on('close', () => {
          try {
            if (watcher) {
              watcher.close();
            }
          } catch {
            // ignore close errors
          }
        });

        return; // Keep connection open
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to start watcher' }));
        return;
      }
    }

    // Run test endpoint
    if (pathname === '/test' && req.method === 'POST') {
      let body = '';

      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          const request: TestRequest = JSON.parse(body);

          // Set up streaming response for terminal output
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Transfer-Encoding': 'chunked',
          });

          if (!jsonRpcClient) {
            res.write('Error: JSON-RPC client not initialized\n');
            res.end();
            return;
          }

          // Convert request to JSON-RPC parameters
          const runParams: any = {
            url: 'http://localhost:6006', // Default Storybook URL
            update: request.action === 'update' || request.action === 'update-baseline',
            grep: request.storyId && request.action !== 'test-all' ? `^${request.storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : undefined,
            summary: true, // Enable summary for better output
            progress: false, // Disable progress to avoid conflicts with streaming
          };

          // Merge in config from request if provided
          if ((request as any).config) {
            Object.assign(runParams, (request as any).config);
          }

          // Set up event handlers to stream output
          jsonRpcClient.on('log', (logData: any) => {
            res.write(logData.message + '\n');
          });

          jsonRpcClient.on('progress', (progress: any) => {
            // Could emit progress information if needed
          });

          jsonRpcClient.on('storyStart', (data: any) => {
            res.write(`Starting: ${data.storyName}\n`);
          });

          jsonRpcClient.on('storyComplete', (result: any) => {
            const status = result.status === 'passed' ? '✓' :
                          result.status === 'failed' ? '✗' :
                          result.status === 'skipped' ? '○' : '?';
            res.write(`${status} ${result.storyName}\n`);
          });

          jsonRpcClient.on('complete', (result: any) => {
            res.write(`\nTest run completed with code: ${result.code}\n`);
            res.end();
          });

          jsonRpcClient.on('error', (error: any) => {
            res.write(`Error: ${error.message}\n`);
            res.end();
          });

          // Start the test run
          try {
            await jsonRpcClient.run(runParams);
          } catch (error) {
            res.write(`Failed to start test run: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
            res.end();
          }
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'Invalid request',
            }),
          );
        }
      });

      return;
    }

    // 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Function to scan failed test results using the new directory structure
  async function scanFailedResults(resultsDir: string): Promise<FailedResult[]> {
    const failedResults: FailedResult[] = [];

    try {
      // Check if directory exists first
      if (!existsSync(resultsDir)) {
        return failedResults;
      }

      // Load Storybook index to get story snapshot paths
      let storySnapshotPaths: Record<string, string> = {};
      try {
        // Try to get Storybook URL from environment or default
        const storybookUrl = process.env.STORYBOOK_URL || 'http://localhost:6006';
        const index = await loadStorybookIndex(storybookUrl);
        if (index) {
          const metadata = extractStoryMetadata(index);
          storySnapshotPaths = metadata.storySnapshotPaths;
        }
      } catch {
        // If we can't load Storybook index, we'll fall back to filename-based matching
      }

      // Helper function to recursively scan directory for PNG files
      async function scanDirectory(
        dir: string,
        baseDir: string = resultsDir,
      ): Promise<Array<{ path: string; relativePath: string; name: string }>> {
        const files: Array<{ path: string; relativePath: string; name: string }> = [];
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              files.push(...(await scanDirectory(fullPath, baseDir)));
            } else if (entry.isFile() && entry.name.endsWith('.png')) {
              const relativePath = relative(baseDir, fullPath);
              // Normalize path separators for comparison
              const normalizedRelativePath = relativePath.replace(/\\/g, '/');
              files.push({
                path: fullPath,
                relativePath: normalizedRelativePath,
                name: entry.name,
              });
            }
          }
        } catch {
          // Ignore errors when scanning
        }
        return files;
      }

      const allPngFiles = await scanDirectory(resultsDir);

      // Build a map of story IDs to failure files
      const storyFailures = new Map<
        string,
        {
          diffPath?: string;
          actualPath?: string;
          errorPath?: string;
        }
      >();

      for (const file of allPngFiles) {
        // Check for diff files
        if (file.name.endsWith('-diff.png')) {
          // Remove -diff.png suffix to get the base path
          const baseRelativePath = file.relativePath.replace(/-diff\.png$/i, '.png');

          // Find matching story ID from snapshot paths
          for (const [storyId, snapshotPath] of Object.entries(storySnapshotPaths)) {
            if (snapshotPath === baseRelativePath) {
              const existing = storyFailures.get(storyId) || {};
              existing.diffPath = file.path;
              storyFailures.set(storyId, existing);
              break;
            }
          }
        }
        // Check for error files
        else if (file.name.endsWith('-error.png')) {
          // Remove -error.png suffix to get the base path
          const baseRelativePath = file.relativePath.replace(/-error\.png$/i, '.png');

          // Find matching story ID from snapshot paths
          for (const [storyId, snapshotPath] of Object.entries(storySnapshotPaths)) {
            if (snapshotPath === baseRelativePath) {
              const existing = storyFailures.get(storyId) || {};
              existing.errorPath = file.path;
              storyFailures.set(storyId, existing);
              break;
            }
          }
        }
        // Check for actual screenshot files (should exist alongside diff or error)
        else if (!file.name.includes('-diff') && !file.name.includes('-error')) {
          // This could be an actual screenshot
          const baseRelativePath = file.relativePath;

          // Check if there's a corresponding diff or error file in the same directory
          const fileDir = dirname(file.path);
          const baseName = file.name.replace(/\.png$/i, '');
          const diffPath = join(fileDir, `${baseName}-diff.png`);
          const errorPath = join(fileDir, `${baseName}-error.png`);

          const hasDiff = existsSync(diffPath);
          const hasError = existsSync(errorPath);

          // If there's a diff or error, this is a failure
          if (hasDiff || hasError) {
            // Find matching story ID from snapshot paths
            for (const [storyId, snapshotPath] of Object.entries(storySnapshotPaths)) {
              if (snapshotPath === baseRelativePath) {
                const existing = storyFailures.get(storyId) || {};
                existing.actualPath = file.path;
                if (hasDiff) existing.diffPath = diffPath;
                if (hasError) existing.errorPath = errorPath;
                storyFailures.set(storyId, existing);
                break;
              }
            }
          }
        }
      }

      // Convert map to FailedResult array
      for (const [storyId, files] of storyFailures.entries()) {
        const storyName = getStoryNameFromId(storyId);

        let errorType: 'screenshot_mismatch' | 'loading_failure' | 'network_error' | 'other_error' =
          'screenshot_mismatch';
        if (files.errorPath && !files.diffPath) {
          // If we have an error file but no diff, it's likely a loading/network error
          errorType = 'loading_failure';
        }

        failedResults.push({
          storyId,
          storyName,
          diffImagePath: files.diffPath,
          actualImagePath: files.actualPath,
          errorImagePath: files.errorPath,
          errorType,
        });
      }
    } catch {
      // ignore scan errors
    }

    return failedResults;
  }

  // Helper to convert Storybook ID to human-readable name
  function getStoryNameFromId(storyId: string): string {
    // Remove viewport suffix if present (e.g., "--unattended", "--attended")
    // Story IDs from visual regression include viewport: "story-id--viewport"
    // But we want just the base story ID
    const baseStoryId = storyId.replace(
      /--(unattended|attended|customer|mobile|tablet|desktop)$/,
      '',
    );

    // Example: "screens-basket--empty" -> "Screens / Basket / Empty"
    const parts = baseStoryId.split('--');
    const title = parts[0]
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(' / ');
    const name = parts[1]
      ? parts[1]
          .split('-')
          .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          .join(' ')
      : '';
    return `${title}${name ? ` / ${name}` : ''}`;
  }

  server.listen(port);

  // Cleanup on process exit
  process.on('exit', () => stopApiServer());
  process.on('SIGINT', () => {
    stopApiServer();
    process.exit();
  });

  return server;
}

export function stopApiServer() {
  if (jsonRpcClient) {
    jsonRpcClient.stop().catch(() => {
      // Ignore cleanup errors
    });
    jsonRpcClient = null;
  }

  if (server) {
    server.close();
    server = null;
  }
}
