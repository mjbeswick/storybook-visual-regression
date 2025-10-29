import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { spawn, ChildProcess, exec } from 'child_process';
import { parse as parseUrl } from 'url';
import { readdir, stat, readFile, mkdir } from 'fs/promises';
import { watch as watchFs } from 'fs';
import { join, relative, dirname } from 'path';
import { existsSync } from 'fs';
import type { Dirent } from 'fs';

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
      // Debounce rapid stop requests
      if (isStopInProgress) {
        console.log(`[VR Addon] Stop request already in progress, ignoring duplicate`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            message: 'Stop request already in progress',
            stoppedCount: 0,
          }),
        );
        return;
      }

      console.log(`[VR Addon] Stop request received. Active processes: ${activeProcesses.size}`);

      // Prevent multiple simultaneous stop requests
      if (activeProcesses.size === 0) {
        console.log(`[VR Addon] No active processes to stop`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            message: 'No active processes to stop',
            stoppedCount: 0,
          }),
        );
        return;
      }

      isStopInProgress = true;

      let stoppedCount = 0;

      try {
        const stopPromises = Array.from(activeProcesses.entries()).map(
          async ([processId, processInfo]) => {
            try {
              const childProcess = processInfo.process;
              if (childProcess && !childProcess.killed && childProcess.pid) {
                console.log(
                  `[VR Addon] Stopping process ${processId} (PID: ${childProcess.pid}) - Command: ${processInfo.command}`,
                );

                // Simple, elegant killing: kill the process group
                try {
                  // Kill the entire process group (includes all child processes)
                  process.kill(-childProcess.pid, 'SIGTERM');
                  console.log(`[VR Addon] Sent SIGTERM to process group ${childProcess.pid}`);

                  // Wait for graceful termination
                  await new Promise((resolve) => setTimeout(resolve, 2000));

                  // Force kill if still running
                  if (!childProcess.killed) {
                    process.kill(-childProcess.pid, 'SIGKILL');
                    console.log(`[VR Addon] Sent SIGKILL to process group ${childProcess.pid}`);
                  }
                } catch (error) {
                  // ESRCH (No such process) is expected when process is already dead
                  if (error instanceof Error && (error as any).code === 'ESRCH') {
                    console.log(`[VR Addon] Process group ${childProcess.pid} already terminated`);
                  } else {
                    console.log(`[VR Addon] Failed to kill process group:`, error);
                  }

                  // Fallback to direct process kill
                  try {
                    childProcess.kill('SIGKILL');
                  } catch (fallbackError) {
                    // ESRCH is expected here too
                    if (fallbackError instanceof Error && (fallbackError as any).code === 'ESRCH') {
                      console.log(`[VR Addon] Process ${childProcess.pid} already terminated`);
                    } else {
                      console.log(`[VR Addon] Fallback kill also failed:`, fallbackError);
                    }
                  }
                }

                if (childProcess.killed) {
                  stoppedCount++;
                  console.log(`[VR Addon] Successfully stopped process ${processId}`);
                } else {
                  console.log(`[VR Addon] Process ${processId} cleanup completed`);
                  // Count as stopped even if we couldn't verify the kill
                  stoppedCount++;
                }

                // Always remove from tracking after kill attempt
                activeProcesses.delete(processId);
              } else {
                // Process was already killed or doesn't exist, just clean up
                activeProcesses.delete(processId);
                stoppedCount++;
              }
            } catch (error) {
              console.log(`[VR Addon] Error stopping process ${processId}:`, error);
              // Still remove from tracking to prevent memory leaks
              activeProcesses.delete(processId);
            }
          },
        );

        // Wait for all stop operations to complete
        await Promise.all(stopPromises);

        console.log(`[VR Addon] Stop operation completed. Stopped ${stoppedCount} processes`);
      } catch (error) {
        console.log(`[VR Addon] Error during stop operation:`, error);
      } finally {
        // Always reset the stop in progress flag
        isStopInProgress = false;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          message: `Stopped ${stoppedCount} running tests`,
          stoppedCount,
        }),
      );
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

          // Set up raw stream for terminal output
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Transfer-Encoding': 'chunked',
          });

          // Build command arguments
          const args: string[] = [];

          // Handle update mode
          if (request.action === 'update' || request.action === 'update-baseline') {
            args.push('--update');
          }
          // For 'test' and 'test-all', no additional args needed - main program runs tests by default

          // Don't pass --url flag - let CLI read from config file

          // Add story filter if provided
          // Use --grep with exact match for better precision
          if (request.storyId && request.action !== 'test-all') {
            // Escape special regex characters and match exactly
            const escapedId = request.storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            args.push('--grep', `^${escapedId}$`);
          }

          // Generate unique process ID and track it
          const processId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

          // Let the CLI determine the appropriate reporter (filtered-reporter for storybook mode)
          const enhancedArgs = [...args];

          // Create clean environment for terminal output
          const cleanEnv = { ...process.env };
          // Remove NO_COLOR to avoid conflicts with FORCE_COLOR
          delete cleanEnv.NO_COLOR;

          // Spawn the CLI process with full terminal support
          // Handle complex commands like Docker by using shell execution
          let child: ChildProcess;

          if (
            cliCommand.includes('docker') ||
            cliCommand.includes('$(pwd)') ||
            cliCommand.includes(' ')
          ) {
            // Complex command - use shell execution
            // Remove -it flags from Docker commands to prevent TTY errors
            let processedCommand = cliCommand;
            // Handle npm run commands first (before Docker processing)
            if (cliCommand.startsWith('npm run')) {
              // For npm run commands, add --silent flag and append arguments with -- separator
              const silentCommand = cliCommand.replace('npm run', 'npm run --silent');
              processedCommand = `${silentCommand} -- ${enhancedArgs.join(' ')}`;
              console.log(`[VR Addon] npm run command, appending with --: ${processedCommand}`);
            } else if (cliCommand.includes('docker run')) {
              // Remove -it flags (both combined and separate) from anywhere in the command
              processedCommand = cliCommand
                .replace(/\s-it\s/g, ' ')
                .replace(/\s-i\s-t\s/g, ' ')
                .replace(/^-it\s/, '')
                .replace(/^-i\s-t\s/, '')
                .replace(/\s-it$/, '')
                .replace(/\s-i\s-t$/, '')
                // Also handle cases where -it is at the beginning without space
                .replace(/^-it/, '')
                .replace(/^-i\s-t/, '')
                // Handle cases where -it is followed by other flags
                .replace(/\s-it\s/, ' ')
                .replace(/\s-i\s-t\s/, ' ');

              console.log(`[VR Addon] Original command: ${cliCommand}`);
              console.log(`[VR Addon] Processed command: ${processedCommand}`);

              // For Docker commands, inject arguments into the CLI command inside Docker
              // Find the CLI command part (after the Docker image name)
              const dockerImageMatch = processedCommand.match(
                /docker run[^]*?storybook-visual-regression:latest\s+(.+)/,
              );
              if (dockerImageMatch) {
                const cliCommand = dockerImageMatch[1];
                const beforeCliCommand = processedCommand.substring(
                  0,
                  processedCommand.indexOf(cliCommand),
                );
                const afterCliCommand = processedCommand.substring(
                  processedCommand.indexOf(cliCommand) + cliCommand.length,
                );

                // Inject arguments into the CLI command
                const enhancedCliCommand = `${cliCommand} ${enhancedArgs.join(' ')}`;
                processedCommand = `${beforeCliCommand}${enhancedCliCommand}${afterCliCommand}`;
                console.log(`[VR Addon] Docker command, injecting into CLI: ${processedCommand}`);
              } else {
                // Fallback: append arguments at the end
                processedCommand = `${processedCommand} ${enhancedArgs.join(' ')}`;
                console.log(`[VR Addon] Docker command fallback: ${processedCommand}`);
              }
            } else {
              // For other commands, append arguments normally
              processedCommand = `${processedCommand} ${enhancedArgs.join(' ')}`;
              console.log(`[VR Addon] Other command: ${processedCommand}`);
            }
            const fullCommand = processedCommand;
            console.log(`[VR Addon] Executing command: ${fullCommand}`);

            // Simple, elegant solution: spawn with process group
            const parts = fullCommand.split(' ');
            const executable = parts[0];
            const args = parts.slice(1);

            child = spawn(executable, args, {
              cwd: process.cwd(),
              env: {
                ...cleanEnv,
                FORCE_COLOR: '3',
                TERM: 'xterm-256color',
                COLUMNS: '120',
                LINES: '30',
                DOCKER_TTY: 'false',
                CI: 'false',
                STORYBOOK_MODE: 'true',
                COLORTERM: 'truecolor',
                NO_COLOR: undefined,
              },
              stdio: ['pipe', 'pipe', 'pipe'],
              detached: true, // Create new process group
            });

            // Track the process with command information
            const processInfo = {
              process: child,
              command: fullCommand,
              startTime: Date.now(),
            };
            activeProcesses.set(processId, processInfo);
          } else {
            // Simple command - direct execution
            const simpleCommand = `${cliCommand} ${enhancedArgs.join(' ')}`;
            console.log(`[VR Addon] Executing simple command: ${simpleCommand}`);
            child = spawn(cliCommand, enhancedArgs, {
              stdio: ['pipe', 'pipe', 'pipe'],
              cwd: process.cwd(),
              env: {
                ...cleanEnv,
                FORCE_COLOR: '3', // Force chalk to output ANSI color codes (level 3 = full color)
                TERM: 'xterm-256color', // Enable full terminal features
                COLUMNS: '120', // Set terminal width for proper formatting
                LINES: '30', // Set terminal height
                // Force TTY detection for CLI tools
                CI: 'false', // Disable CI mode
                STORYBOOK_MODE: 'true', // Enable Storybook mode
                // Additional color forcing
                COLORTERM: 'truecolor', // Enable true color support
                NO_COLOR: undefined, // Ensure NO_COLOR is not set
              },
              // Don't detach the process so we can kill it properly
              detached: false,
            });

            // Track the process with command information
            const processInfo = {
              process: child,
              command: simpleCommand,
              startTime: Date.now(),
            };
            activeProcesses.set(processId, processInfo);
          }

          child.stdout?.on('data', (data) => {
            const chunk = data.toString();

            // Replace host.docker.internal with localhost in URLs for better accessibility
            const processedChunk = chunk.replace(/host\.docker\.internal/g, 'localhost');

            // Log when URL replacement happens for debugging
            if (processedChunk !== chunk) {
              console.log('[VR Addon] Replaced host.docker.internal with localhost in output');
            }

            // Stream raw terminal output directly (no JSON wrapping)
            res.write(processedChunk);
          });

          child.stderr?.on('data', (data) => {
            const chunk = data.toString();

            // Replace host.docker.internal with localhost in URLs for better accessibility
            const processedChunk = chunk.replace(/host\.docker\.internal/g, 'localhost');

            // Log when URL replacement happens for debugging
            if (processedChunk !== chunk) {
              console.log('[VR Addon] Replaced host.docker.internal with localhost in stderr');
            }

            // Stream stderr directly as well
            res.write(processedChunk);
          });

          child.on('error', (error) => {
            // Clean up the process
            activeProcesses.delete(processId);

            // Handle EPIPE errors gracefully (pipe closed by client)
            if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
              return;
            }

            res.write(
              `data: ${JSON.stringify({
                type: 'error',
                storyId: request.storyId,
                error: `Failed to run CLI: ${error.message}`,
              })}\n\n`,
            );
            res.end();
          });

          child.on('close', (code, signal) => {
            // Clean up the process
            activeProcesses.delete(processId);

            // Just end the stream - terminal output is complete
            res.end();
          });
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
  if (server) {
    server.close();
    server = null;
  }
}
