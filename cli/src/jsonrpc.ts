import { spawn, ChildProcess } from 'child_process';
import { RuntimeConfig } from './config.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

// CLI methods that can be called via JSON-RPC
export const CLI_METHODS = {
  // Control methods
  RUN: 'run',
  CANCEL: 'cancel',

  // Configuration methods
  SET_CONFIG: 'setConfig',
  GET_CONFIG: 'getConfig',

  // Status methods
  GET_STATUS: 'getStatus',
  GET_RESULTS: 'getResults',
} as const;

// Events that the CLI can emit via JSON-RPC notifications
export const CLI_EVENTS = {
  // Progress events
  PROGRESS: 'progress',
  STORY_START: 'storyStart',
  STORY_COMPLETE: 'storyComplete',

  // Result events
  RESULT: 'result',
  LOG: 'log',

  // Status events
  READY: 'ready',
  COMPLETE: 'complete',
  ERROR: 'error',
} as const;

export interface StoryResult {
  storyId: string;
  storyName: string;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut';
  duration?: number;
  error?: string;
  diffPath?: string;
  actualPath?: string;
  expectedPath?: string;
  errorPath?: string;
  errorType?: 'screenshot_mismatch' | 'loading_failure' | 'network_error' | 'other_error';
  diffPixels?: number;
  diffPercent?: number;
}

export interface ProgressInfo {
  completed: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  currentStory?: string;
  elapsed?: number;
  estimated?: number;
}

export interface RunParams {
  url?: string;
  output?: string;
  workers?: number;
  maxFailures?: number;
  browser?: 'chromium' | 'firefox' | 'webkit';
  threshold?: number;
  maxDiffPixels?: number;
  fullPage?: boolean;
  mutationWait?: number;
  mutationTimeout?: number;
  snapshotRetries?: number;
  snapshotDelay?: number;
  grep?: string;
  include?: string;
  exclude?: string;
  update?: boolean;
  missingOnly?: boolean;
  failedOnly?: boolean;
  quiet?: boolean;
  showProgress?: boolean;
  summary?: boolean;
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  fixDate?: boolean | string | number;
  timezone?: string;
  locale?: string;
  webserverTimeout?: number;
  overlayTimeout?: number;
  testTimeout?: number;
  notFoundCheck?: boolean;
  notFoundRetryDelay?: number;
  installBrowsers?: boolean | string;
  installDeps?: boolean;
}

/**
 * JSON-RPC client for communicating with the CLI over stdio
 */
export class JsonRpcClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (value: any) => void;
      reject: (error: any) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private listeners = new Map<string, Set<(params: any) => void>>();

  constructor(private cliCommand: string = 'npx @storybook-visual-regression/cli') {}

  /**
   * Start the CLI process in JSON-RPC mode
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Spawn CLI with --json-rpc flag
      this.process = spawn(this.cliCommand, ['--json-rpc'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          // Ensure JSON output is not colored
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      });

      if (!this.process.stdout || !this.process.stderr || !this.process.stdin) {
        reject(new Error('Failed to create process streams'));
        return;
      }

      let stdoutBuffer = '';
      let stderrBuffer = '';

      // Handle stdout (JSON-RPC messages)
      this.process.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();

        // Process complete JSON-RPC messages
        const messages = this.parseJsonRpcMessages(stdoutBuffer);
        if (messages.length > 0) {
          stdoutBuffer = messages.pop()?.remaining || '';
          for (const message of messages) {
            this.handleMessage(message.message);
          }
        }
      });

      // Handle stderr (logs and errors)
      this.process.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        // Emit log events for stderr output
        this.emit('log', { level: 'error', message: stderrBuffer.trim() });
        stderrBuffer = '';
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        this.emit('exit', { code, signal });
        this.cleanup();
      });

      // Handle process errors
      this.process.on('error', (error) => {
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

  /**
   * Stop the CLI process
   */
  async stop(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');

      // Wait for graceful shutdown or force kill after timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.cleanup();
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async request<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      // Send request
      this.sendMessage(request);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  notify(method: string, params?: any): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.sendMessage(notification);
  }

  /**
   * Listen for events/notifications
   */
  on(event: string, listener: (params: any) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  /**
   * Listen for events/notifications once
   */
  once(event: string, listener: (params: any) => void): void {
    const onceListener = (params: any) => {
      this.off(event, onceListener);
      listener(params);
    };
    this.on(event, onceListener);
  }

  /**
   * Stop listening for events
   */
  off(event: string, listener: (params: any) => void): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  // Convenience methods for CLI operations
  async run(params: RunParams): Promise<any> {
    return this.request(CLI_METHODS.RUN, params);
  }

  async cancel(): Promise<any> {
    return this.request(CLI_METHODS.CANCEL);
  }

  async setConfig(config: Partial<RuntimeConfig>): Promise<any> {
    return this.request(CLI_METHODS.SET_CONFIG, config);
  }

  async getConfig(): Promise<RuntimeConfig> {
    return this.request(CLI_METHODS.GET_CONFIG);
  }

  async getStatus(): Promise<any> {
    return this.request(CLI_METHODS.GET_STATUS);
  }

  async getResults(): Promise<StoryResult[]> {
    return this.request(CLI_METHODS.GET_RESULTS);
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
          // If parsing fails, treat as log message
          this.emit('log', { level: 'info', message: line });
        }
      }
    }

    return messages;
  }

  private cleanup(): void {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(new Error('Process terminated'));
    }

    this.listeners.clear();
    this.process = null;
  }
}

/**
 * JSON-RPC server for the CLI (handles incoming requests from clients)
 */
export class JsonRpcServer {
  private listeners = new Map<string, Set<(params: any) => Promise<any>>>();
  private nextId = 1;

  constructor(
    private stdin = process.stdin,
    private stdout = process.stdout,
    private stderr = process.stderr,
  ) {}

  /**
   * Start listening for JSON-RPC messages
   */
  start(): void {
    let buffer = '';

    console.error('[CLI] Starting JSON-RPC server, setting up stdin listeners...');
    console.error(`[CLI] stdin readable: ${this.stdin.readable}, isTTY: ${this.stdin.isTTY}`);

    // Ensure stdin is readable and not paused
    this.stdin.resume();
    this.stdin.setEncoding('utf8');

    // Shared function to process incoming data
    const processData = (dataStr: string) => {
      console.error(
        `[CLI] Processing data (${dataStr.length} bytes): ${dataStr.substring(0, 200)}`,
      );
      buffer += dataStr;

      // Process complete messages
      const messages = this.parseJsonRpcMessages(buffer);
      console.error(`[CLI] Parsed ${messages.length} message(s) from buffer`);
      if (messages.length > 0) {
        // Get the remaining buffer from the last message (if any incomplete message remains)
        const lastMessage = messages[messages.length - 1];
        buffer = lastMessage.remaining;

        // Process all complete messages (handleMessage is async, but we don't await to avoid blocking)
        for (const msg of messages) {
          console.error(
            `[CLI] Processing message: ${JSON.stringify(msg.message).substring(0, 200)}`,
          );
          // Fire and forget - handleMessage will send responses asynchronously
          this.handleMessage(msg.message).catch((error) => {
            console.error('[CLI] Error handling message:', error);
          });
        }
      }
    };

    // Listen for 'data' events (works for TTY)
    // Note: For pipes, 'readable' is more reliable, so we'll primarily use that
    // But keep 'data' as a fallback
    let usingReadable = false;
    this.stdin.on('data', (data) => {
      if (!usingReadable) {
        console.error(`[CLI] Received 'data' event`);
        processData(data.toString());
      }
    });

    this.stdin.on('end', () => {
      console.error('[CLI] stdin ended');
      process.exit(0);
    });

    this.stdin.on('error', (error) => {
      console.error('[CLI] stdin error:', error);
    });

    // Also handle 'readable' event and read manually (for pipes, this is more reliable)
    this.stdin.on('readable', () => {
      usingReadable = true; // Mark that we're using readable mode
      console.error('[CLI] stdin is readable, reading...');
      let chunk: Buffer | string | null;
      while ((chunk = this.stdin.read()) !== null) {
        console.error(`[CLI] Read chunk from stdin (${chunk.length} bytes)`);
        processData(chunk.toString());
      }
    });

    console.error('[CLI] JSON-RPC server started, waiting for messages...');
  }

  /**
   * Register a method handler
   */
  on(method: string, handler: (params: any) => Promise<any>): void {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method)!.add(handler);
  }

  /**
   * Send a notification to the client
   */
  notify(method: string, params?: any): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.sendMessage(notification);
  }

  /**
   * Send a response to a request
   */
  respond(id: number | string | null, result: any): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.sendMessage(response);
  }

  /**
   * Send an error response
   */
  error(id: number | string | null, code: number, message: string, data?: any): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
    this.sendMessage(response);
  }

  /**
   * Send a log message to stderr
   */
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string): void {
    this.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
  }

  private async handleMessage(message: any): Promise<void> {
    if (message.jsonrpc !== '2.0') {
      return;
    }

    if ('method' in message && 'id' in message) {
      // This is a request - handle it and send response
      console.error(`[CLI] Received request: ${message.method} (ID: ${message.id})`);
      const handlers = this.listeners.get(message.method);
      if (handlers) {
        try {
          console.error(`[CLI] Found ${handlers.size} handler(s) for ${message.method}`);
          const result = await Promise.race([
            ...Array.from(handlers).map((handler) => handler(message.params)),
          ]);
          console.error(`[CLI] Handler completed, sending response for ID ${message.id}`);
          this.respond(message.id, result);
        } catch (error) {
          console.error(`[CLI] Handler error for ${message.method}:`, error);
          this.error(message.id, -32000, error instanceof Error ? error.message : 'Unknown error');
        }
      } else {
        console.error(`[CLI] No handler found for method: ${message.method}`);
        this.error(message.id, -32601, `Method not found: ${message.method}`);
      }
    }
    // Notifications are ignored (no response needed)
  }

  private sendMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    const json = JSON.stringify(message) + '\n';
    console.error(`[CLI] Sending message: ${json.substring(0, 100)}...`);
    this.stdout.write(json);
    // Ensure stdout is flushed
    if (this.stdout.isTTY === false) {
      // For non-TTY streams, we might need to ensure it's flushed
      // But write() should handle this automatically
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
}
