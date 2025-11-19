import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadAddonConfig } from './config.js';
import { EVENTS } from './constants.js';

type Channel = {
  emit: (event: string, data?: unknown) => void;
  on: (event: string, callback: (data?: unknown) => void) => void;
  off: (event: string, callback: (data?: unknown) => void) => void;
};

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: any;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: any;
};

/**
 * Bridge between Storybook channel API and CLI JSON-RPC over stdio
 */
export class JsonRpcBridge {
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
  private channel: Channel | null = null;
  private stdoutBuffer = '';
  private isReady = false;
  private readyResolve: (() => void) | null = null;

  constructor(private cliCommand: string = 'npx @storybook-visual-regression/cli') {}

  /**
   * Start the bridge by spawning CLI and setting up communication
   */
  async start(channel: Channel): Promise<void> {
    this.channel = channel;

    return new Promise((resolve, reject) => {
      // Parse CLI command - handle npm scripts and direct commands
      // Always ensure --json-rpc is added (unless already present)
      let command: string;
      let args: string[];
      let useShell = false;

      // Check if --json-rpc is already in the command
      const hasJsonRpc = this.cliCommand.includes('--json-rpc');

      if (this.cliCommand.startsWith('npm ')) {
        // For npm commands, we need to use -- to pass arguments to the script
        // npm run script-name -- --json-rpc
        if (hasJsonRpc) {
          command = this.cliCommand;
        } else {
          command = `${this.cliCommand} -- --json-rpc`;
        }
        args = [];
        useShell = true;
      } else if (this.cliCommand.startsWith('npx ')) {
        // For npx commands, we can append --json-rpc directly
        if (hasJsonRpc) {
          command = this.cliCommand;
        } else {
          command = `${this.cliCommand} --json-rpc`;
        }
        args = [];
        useShell = true;
      } else {
        // Direct command - split into command and args
        const parts = this.cliCommand.split(/\s+/);
        command = parts[0];
        if (hasJsonRpc) {
          args = parts.slice(1);
        } else {
          args = [...parts.slice(1), '--json-rpc'];
        }
      }

      // Find project root (look for package.json or .git directory)
      let projectRoot = process.cwd();
      let currentDir = process.cwd();

      // Walk up directories to find project root
      for (let i = 0; i < 10; i++) { // Prevent infinite loop
        try {
          const packageJsonPath = path.join(currentDir, 'package.json');
          const gitPath = path.join(currentDir, '.git');

          if (fs.existsSync(packageJsonPath) || fs.existsSync(gitPath)) {
            projectRoot = currentDir;
            break;
          }

          const parentDir = path.dirname(currentDir);
          if (parentDir === currentDir) {
            // Reached root directory
            break;
          }
          currentDir = parentDir;
        } catch (error) {
          // If we can't access a directory, stop trying
          break;
        }
      }

      // Spawn CLI with --json-rpc flag
      console.log(`[VR Addon] Spawning CLI from project root: ${projectRoot}`);
      console.log(`[VR Addon] CLI command: ${command} ${args.join(' ')}`);
      console.log(`[VR Addon] Working directory: ${projectRoot}`);
      console.log(`[VR Addon] Current process.cwd(): ${process.cwd()}`);
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectRoot,
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          // Prevent CLI from triggering file system events that affect Vite
          CI: 'true',
          NODE_ENV: 'production',
          // Additional isolation to prevent build system interference
          VITE_SKIP_WATCH: 'true',
          DISABLE_HMR: 'true',
          SKIP_PREFLIGHT_CHECK: 'true',
          // Storybook-specific environment variables
          STORYBOOK_DISABLE_HMR: 'true',
          STORYBOOK_SKIP_HMR: 'true',
          // Prevent any WebSocket or network communication that might trigger HMR
          DISABLE_WEB_SOCKETS: 'true',
          NO_HMR: '1',
        },
        shell: useShell,
      });

      if (!this.process.stdout || !this.process.stderr || !this.process.stdin) {
        reject(new Error('Failed to create process streams'));
        return;
      }

      // Handle stdout (JSON-RPC messages)
      this.process.stdout.on('data', (data: Buffer) => {
        const rawData = data.toString();
        console.log('[VR Addon] CLI stdout (raw):', rawData.substring(0, 200));
        this.stdoutBuffer += rawData;
        const messages = this.parseJsonRpcMessages(this.stdoutBuffer);
        console.log(`[VR Addon] Parsed ${messages.length} JSON-RPC message(s) from stdout`);
        if (messages.length > 0) {
          // Get the remaining buffer from the last message (if any incomplete message remains)
          const lastMessage = messages[messages.length - 1];
          this.stdoutBuffer = lastMessage.remaining;

          // Process all complete messages
          for (const message of messages) {
            console.log(
              '[VR Addon] Handling message:',
              JSON.stringify(message.message).substring(0, 200),
            );
            this.handleMessage(message.message);
          }
        }
      });

      // Handle stderr (logs and errors)
      let stderrBuffer = '';
      this.process.stderr.on('data', (data: Buffer) => {
        const message = data.toString();
        stderrBuffer += message;
        // Log stderr for debugging
        if (message.trim()) {
          console.error('[VR Addon] CLI stderr:', message.trim());
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        this.cleanup();
        if (!this.isReady) {
          let errorMsg =
            stderrBuffer.trim() || `CLI process exited before ready: ${code} ${signal}`;

          // Provide helpful error message for missing --json-rpc flag
          if (errorMsg.includes('unknown option') && errorMsg.includes('--json-rpc')) {
            errorMsg = `The CLI version does not support --json-rpc mode. Please rebuild your docker image with: npm run docker:build\n\nOriginal error: ${errorMsg}`;
          }

          console.error('[VR Addon] CLI process failed:', errorMsg);
          reject(new Error(errorMsg));
        }
      });

      // Handle process errors
      this.process.on('error', (error: Error) => {
        this.cleanup();
        reject(error);
      });

      // Wait for ready notification
      this.readyResolve = () => {
        this.isReady = true;
        console.log('[VR Addon] Bridge ready - CLI process started successfully');
        resolve();
      };

      // Set up channel event handlers
      this.setupChannelHandlers();
    });
  }

  /**
   * Stop the bridge and cleanup
   */
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
        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    this.cleanup();
  }

  /**
   * Send a JSON-RPC request (public method)
   */
  async request<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
    // Wait for bridge to be ready (up to 10 seconds)
    if (!this.isReady) {
      const maxWait = 10000;
      const startTime = Date.now();
      while (!this.isReady && Date.now() - startTime < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!this.isReady) {
        throw new Error('CLI process not ready. Please wait a moment and try again.');
      }
    }

    if (!this.process || !this.process.stdin) {
      throw new Error('CLI process not started');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    console.log(
      `[VR Addon] Sending request: ${method} (ID: ${id})`,
      params ? JSON.stringify(params).substring(0, 200) : '',
    );
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log(`[VR Addon] Request timeout: ${method} (ID: ${id})`);
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const json = JSON.stringify(request) + '\n';
      console.log(`[VR Addon] Writing to stdin: ${json.substring(0, 200)}`);
      this.process!.stdin!.write(json);
    });
  }

  /**
   * Send a JSON-RPC notification
   */
  private notify(method: string, params?: any): void {
    if (!this.process || !this.process.stdin) {
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const json = JSON.stringify(notification) + '\n';
    this.process.stdin.write(json);
  }

  /**
   * Set up event listeners for Storybook channel events
   * NOTE: This method is no longer needed - all Storybook channel events are handled by preview.ts
   * The bridge only forwards RPC requests and notifications, not Storybook channel events
   */
  private setupChannelHandlers(): void {
    // All channel event handlers have been moved to preview.ts
    // The bridge should only handle RPC requests via the HTTP server
    // No-op for now, but keeping the method in case we need it later
  }

  /**
   * Handle incoming JSON-RPC messages from CLI
   */
  private handleMessage(message: any): void {
    console.log('[VR Addon] handleMessage called with:', JSON.stringify(message).substring(0, 300));
    if (message.jsonrpc !== '2.0') {
      console.log('[VR Addon] Message does not have jsonrpc 2.0, ignoring');
      return;
    }

    if ('id' in message && message.id !== null) {
      // This is a response
      console.log(`[VR Addon] Received response for request ID ${message.id}`);
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timeout);

        if ('error' in message) {
          console.log('[VR Addon] Response has error:', message.error);
          pending.reject(new Error(message.error.message));
        } else {
          console.log(
            '[VR Addon] Response has result:',
            JSON.stringify(message.result).substring(0, 200),
          );
          pending.resolve(message.result);
        }
      } else {
        console.log(`[VR Addon] No pending request found for ID ${message.id}`);
      }
    } else {
      // This is a notification - forward to channel
      console.log(`[VR Addon] Received notification: ${message.method}`);
      this.forwardNotification(message.method, message.params);
    }
  }

  /**
   * Forward JSON-RPC notifications to channel
   * The channel will forward to HTTP clients via the preset
   */
  private forwardNotification(method: string, params?: any): void {
    console.log(
      `[VR Addon] forwardNotification: ${method}`,
      params ? JSON.stringify(params).substring(0, 200) : '',
    );
    if (!this.channel) {
      console.log('[VR Addon] No channel available, cannot forward notification');
      return;
    }

    switch (method) {
      case 'ready':
        // CLI is ready
        console.log('[VR Addon] Received ready notification from CLI');
        if (this.readyResolve) {
          console.log('[VR Addon] Calling readyResolve to mark bridge as ready');
          this.readyResolve();
          this.readyResolve = null;
        } else {
          console.log(
            '[VR Addon] Warning: ready notification received but no readyResolve callback',
          );
        }
        break;

      default:
        // Forward all notifications with method name as event type
        // The preset will forward these to HTTP clients, and the preview will map them
        this.channel.emit(method, params);
        break;
    }
  }

  /**
   * Parse JSON-RPC messages from buffer
   */
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

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(new Error('Process terminated'));
    }
    this.process = null;
  }
}

// Global bridge instance
let bridgeInstance: JsonRpcBridge | null = null;

/**
 * Get or create the bridge instance
 */
export function getJsonRpcBridge(cliCommand?: string): JsonRpcBridge {
  if (!bridgeInstance) {
    if (cliCommand) {
      bridgeInstance = new JsonRpcBridge(cliCommand);
    } else {
      const config = loadAddonConfig();
      bridgeInstance = new JsonRpcBridge(config.cliCommand);
    }
  }
  return bridgeInstance;
}
