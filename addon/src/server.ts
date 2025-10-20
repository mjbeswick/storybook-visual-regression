import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { spawn } from 'child_process';
import { parse as parseUrl } from 'url';
import { readdir, stat, readFile } from 'fs/promises';
import { watch as watchFs } from 'fs';
import { join } from 'path';

type TestRequest = {
  action: 'test' | 'update' | 'test-all';
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

export function startApiServer(port = 6007): Server {
  if (server) {
    console.log('[Visual Regression] API server already running');
    return server;
  }

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
      } catch (error) {
        console.error('[Visual Regression] Error scanning failed results:', error);
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
      } catch (error) {
        console.error('[Visual Regression] Error serving image:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to serve image' }));
        return;
      }
    }

    // Stop all running tests endpoint
    if (pathname === '/stop' && req.method === 'POST') {
      console.log('[Visual Regression] Stopping all running tests...');
      let stoppedCount = 0;

      for (const [processId, childProcess] of activeProcesses) {
        try {
          if (childProcess && !childProcess.killed) {
            childProcess.kill('SIGTERM');
            stoppedCount++;
            console.log(`[Visual Regression] Stopped process ${processId}`);
          }
        } catch (error) {
          console.error(`[Visual Regression] Error stopping process ${processId}:`, error);
        }
      }

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

        // Start watcher
        const watcher = watchFs(resultsDir, { recursive: true }, () => {
          if (scheduled) return;
          scheduled = true;
          setTimeout(async () => {
            scheduled = false;
            await sendSnapshotIfChanged();
          }, 200);
        });

        // Cleanup on client disconnect
        req.on('close', () => {
          try {
            watcher.close();
          } catch {
            // ignore close errors
          }
        });

        return; // Keep connection open
      } catch (error) {
        console.error('[Visual Regression] Error starting failed results watcher:', error);
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

          // Set up Server-Sent Events for streaming output
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          // Build command arguments
          const args: string[] = [];

          if (request.action === 'test') {
            args.push('test');
          } else if (request.action === 'update') {
            args.push('update');
          } else if (request.action === 'test-all') {
            args.push('test');
          }

          // Add story filter if provided
          // Use --grep with exact match for better precision
          if (request.storyId && request.action !== 'test-all') {
            // Escape special regex characters and match exactly
            const escapedId = request.storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            args.push('--grep', `^${escapedId}$`);
          }

          // Always use JSON output
          args.push('--json');

          // Send initial status
          res.write(`data: ${JSON.stringify({ type: 'start', storyId: request.storyId })}\n\n`);

          // Log the command being run for debugging
          console.log(`[Visual Regression] Running: storybook-visual-regression ${args.join(' ')}`);
          console.log(`[Visual Regression] Story ID: ${request.storyId}`);
          console.log(`[Visual Regression] Request body:`, JSON.stringify(request, null, 2));

          // Generate unique process ID and track it
          const processId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

          // Spawn the CLI process
          const child = spawn('storybook-visual-regression', args, {
            stdio: 'pipe',
            cwd: process.cwd(),
          });

          // Track the process
          activeProcesses.set(processId, child);

          let stdout = '';
          let stderr = '';

          child.stdout?.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;

            // Check for individual test results in the chunk
            const lines = chunk.split('\n');
            let filteredChunk = '';

            for (const line of lines) {
              if (line.trim()) {
                try {
                  const parsed = JSON.parse(line);
                  if (parsed.type === 'test-result') {
                    // Forward individual test result immediately
                    res.write(
                      `data: ${JSON.stringify({
                        type: 'test-result',
                        test: parsed.test,
                        storyId: request.storyId,
                      })}\n\n`,
                    );
                    // Don't include this line in stdout
                    continue;
                  } else {
                    // Other JSON (like final summary) - include in stdout for later parsing
                    filteredChunk += line + '\n';
                  }
                } catch {
                  // Not JSON, include in filtered chunk
                  filteredChunk += line + '\n';
                }
              } else {
                filteredChunk += line + '\n';
              }
            }

            // Only stream non-JSON content
            if (filteredChunk.trim()) {
              res.write(`data: ${JSON.stringify({ type: 'stdout', data: filteredChunk })}\n\n`);
            }
          });

          child.stderr?.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            res.write(`data: ${JSON.stringify({ type: 'stderr', data: chunk })}\n\n`);
          });

          child.on('error', (error) => {
            // Clean up the process
            activeProcesses.delete(processId);

            res.write(
              `data: ${JSON.stringify({
                type: 'error',
                storyId: request.storyId,
                error: `Failed to run CLI: ${error.message}`,
              })}\n\n`,
            );
            res.end();
          });

          child.on('close', (code) => {
            // Clean up the process
            activeProcesses.delete(processId);

            // Try to parse JSON output
            let result = null;
            try {
              // The CLI outputs JSON, try to find and parse it
              const jsonMatch = stdout.match(/\{[\s\S]*"status"[\s\S]*\}/);
              if (jsonMatch) {
                result = JSON.parse(jsonMatch[0]);
              }
            } catch {
              // Not valid JSON, that's okay
            }

            res.write(
              `data: ${JSON.stringify({
                type: 'complete',
                exitCode: code,
                storyId: request.storyId,
                result,
                stdout: !result ? stdout : undefined,
                stderr: stderr || undefined,
              })}\n\n`,
            );
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
            console.log('[Visual Regression] Found image file:', imageFile);
            const imageMatch = imageFile.match(/(.+?)-(actual|expected|diff)\.png$/);
            if (imageMatch) {
              console.log('[Visual Regression] Extracted story ID from image:', imageMatch[1]);
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
    } catch (error) {
      console.warn('[Visual Regression] Could not scan results directory:', error);
    }

    return failedResults;
  }

  // Helper to convert Storybook ID to human-readable name
  function getStoryNameFromId(storyId: string): string {
    // Example: "screens-basket--empty" -> "Screens / Basket ❯ Empty"
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
    return `${title}${name ? ` ❯ ${name}` : ''}`;
  }

  server.listen(port, () => {
    console.log(`[Visual Regression] API server running on http://localhost:${port}`);
  });

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
    console.log('[Visual Regression] API server stopped');
  }
}
