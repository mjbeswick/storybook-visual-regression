import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { spawn, ChildProcess, exec } from 'child_process';
import { parse as parseUrl } from 'url';
import { readdir, stat, readFile, mkdir } from 'fs/promises';
import { watch as watchFs } from 'fs';
import { join } from 'path';

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
};

let server: Server | null = null;
const activeProcesses = new Map<string, ReturnType<typeof spawn>>(); // Track active CLI processes

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

export function startApiServer(port = 6007, cliCommand = 'storybook-visual-regression'): Server {
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
      let stoppedCount = 0;

      const stopPromises = Array.from(activeProcesses.entries()).map(async ([, childProcess]) => {
        try {
          if (childProcess && !childProcess.killed && childProcess.pid) {
            // First try graceful termination of the entire process group
            try {
              // On Unix systems, kill the entire process group using negative PID
              process.kill(-childProcess.pid, 'SIGTERM');
            } catch {
              // If process group kill fails, fall back to individual process kill
              childProcess.kill('SIGTERM');
            }

            // Wait a bit for graceful termination
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Check if process is still running
            if (!childProcess.killed) {
              try {
                // Try to kill the entire process group with SIGKILL
                process.kill(-childProcess.pid, 'SIGKILL');
              } catch {
                // Fall back to individual process kill
                childProcess.kill('SIGKILL');
              }

              // Wait a bit more for force kill
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            if (childProcess.killed) {
              stoppedCount++;
            }
          }
        } catch {
          // ignore process stopping errors
        }
      });

      // Wait for all stop operations to complete
      await Promise.all(stopPromises);

      activeProcesses.clear();

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

          // Add story filter if provided
          // Use --grep with exact match for better precision
          if (request.storyId && request.action !== 'test-all') {
            // Escape special regex characters and match exactly
            const escapedId = request.storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            args.push('--grep', `^${escapedId}$`);
          }

          // Add --storybook flag to ensure filtered reporter with time estimates is used
          args.push('--storybook');

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
            console.log(`[VR Addon] Environment variables:`, {
              FORCE_COLOR: '3',
              TERM: 'xterm-256color',
              STORYBOOK_MODE: 'true',
              CI: 'false',
              COLORTERM: 'truecolor',
            });
            child = exec(fullCommand, {
              cwd: process.cwd(),
              env: {
                ...cleanEnv,
                FORCE_COLOR: '3', // Force chalk to output ANSI color codes (level 3 = full color)
                TERM: 'xterm-256color', // Enable full terminal features
                COLUMNS: '120', // Set terminal width for proper formatting
                LINES: '30', // Set terminal height
                DOCKER_TTY: 'false', // Prevent Docker from trying to allocate TTY
                // Force TTY detection for CLI tools
                CI: 'false', // Disable CI mode
                STORYBOOK_MODE: 'true', // Enable Storybook mode
                // Additional color forcing
                COLORTERM: 'truecolor', // Enable true color support
                NO_COLOR: undefined, // Ensure NO_COLOR is not set
              },
            });
          } else {
            // Simple command - direct execution
            console.log(
              `[VR Addon] Executing simple command: ${cliCommand} ${enhancedArgs.join(' ')}`,
            );
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
              // Create a new process group to enable killing all child processes
              detached: true,
            });
          }

          // Track the process
          activeProcesses.set(processId, child);

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

          child.on('close', () => {
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

  // Function to scan failed test results
  async function scanFailedResults(resultsDir: string): Promise<FailedResult[]> {
    const failedResults: FailedResult[] = [];

    try {
      // Check if directory exists first
      try {
        await stat(resultsDir);
      } catch {
        // Directory doesn't exist, return empty results
        return failedResults;
      }

      const entries = await readdir(resultsDir);

      for (const entry of entries) {
        const entryPath = join(resultsDir, entry);
        const stats = await stat(entryPath);

        if (stats.isDirectory() && entry.startsWith('storybook-Visual-Regressio-')) {
          // This is a failed test result directory
          // Extract story ID from directory name
          // Example: "storybook-Visual-Regressio-00c0e-mpty-screens-basket--empty--chromium"
          // We need to extract "screens-basket--empty"

          // Extract story ID from image filenames instead of directory name
          // The directory name is often truncated, but image filenames contain the full story ID
          const subEntries = await readdir(entryPath);
          let storyId: string | undefined;

          // Look for image files that contain the complete story ID
          const storyFiles = subEntries.filter(
            (subEntry) =>
              subEntry.includes('-actual.png') ||
              subEntry.includes('-expected.png') ||
              subEntry.includes('-diff.png'),
          );

          if (storyFiles.length > 0) {
            // Extract story ID from the first image filename
            const imageFile = storyFiles[0];
            const imageMatch = imageFile.match(/(.+?)-(actual|expected|diff)\.png$/);
            if (imageMatch) {
              storyId = imageMatch[1];
            }
          }

          if (storyId) {
            let diffImagePath: string | undefined;
            let actualImagePath: string | undefined;
            let expectedImagePath: string | undefined;

            for (const subEntry of subEntries) {
              const subPath = join(entryPath, subEntry);
              const subStats = await stat(subPath);

              if (subStats.isFile()) {
                if (subEntry.includes('-diff.png')) {
                  diffImagePath = subPath;
                } else if (subEntry.includes('-actual.png')) {
                  actualImagePath = subPath;
                } else if (subEntry.includes('-expected.png')) {
                  expectedImagePath = subPath;
                }
              }
            }

            // Convert story ID to story name
            const storyName = getStoryNameFromId(storyId);

            failedResults.push({
              storyId,
              storyName,
              diffImagePath,
              actualImagePath,
              expectedImagePath,
            });
          }
        }
      }
    } catch {
      // ignore scan errors
    }

    return failedResults;
  }

  // Helper to convert Storybook ID to human-readable name
  function getStoryNameFromId(storyId: string): string {
    // Example: "screens-basket--empty" -> "Screens / Basket / Empty"
    const parts = storyId.split('--');
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
