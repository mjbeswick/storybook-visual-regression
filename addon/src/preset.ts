import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { parse as parseUrl } from 'url';
import { join } from 'path';
import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { getJsonRpcBridge } from './JsonRpcBridge.js';
import { loadAddonConfig } from './config.js';
import { EVENTS } from './constants.js';

let server: Server | null = null;
let bridge: ReturnType<typeof getJsonRpcBridge> | null = null;
const eventListeners = new Set<(type: string, payload: any) => void>();

// Create a channel-like object that forwards events to HTTP clients
const eventChannel = {
  emit: (method: string, data?: unknown) => {
    // Forward events to all connected listeners (HTTP SSE clients)
    // The method name becomes the event type
    for (const listener of eventListeners) {
      listener(method, data);
    }
  },
  on: () => {},
  off: () => {},
};

export interface AddonOptions {
  cliCommand?: string;
}

export function managerEntries(entry: string[] = []) {
  return [...entry, require.resolve('./manager')];
}

export function previewAnnotations(entry: string[] = [], options: AddonOptions = {}) {
  // Start bridge and HTTP server (only once)
  if (!server) {
    try {
      const defaultConfig = loadAddonConfig();
      const cliCommand = options.cliCommand || defaultConfig.cliCommand;

      // Create bridge with the CLI command
      bridge = getJsonRpcBridge(cliCommand);

      // Start bridge (this will spawn CLI)
      bridge.start(eventChannel as any).catch((error) => {
        console.error('[VR Addon] Failed to start bridge:', error);
      });

      // Log when bridge is ready (for debugging)
      // Note: We don't wait for bridge to be ready here because it's async
      // The request handler will wait for readiness

      // Create minimal HTTP server for browser <-> Node.js communication
      server = createServer(handleRequest);
      server.listen(6007, () => {
        console.log('[VR Addon] RPC server listening on port 6007');
      });

      // Cleanup on exit
      process.on('exit', () => {
        if (bridge) {
          bridge.stop().catch(() => {});
        }
        if (server) {
          server.close();
        }
      });
    } catch (error) {
      console.error('[VR Addon] Failed to start server:', error);
    }
  }

  return [...entry, require.resolve('./preview')];
}

/**
 * Handle HTTP requests from browser
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Enable CORS
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

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'visual-regression-addon' }));
    return;
  }

  // SSE endpoint for events
  if (pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const listener = (type: string, payload: any) => {
      res.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
    };

    eventListeners.add(listener);

    req.on('close', () => {
      eventListeners.delete(listener);
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    return;
  }

  // Endpoint to receive events from manager and forward to preview
  if (pathname === '/emit-event' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { event, data } = JSON.parse(body);
        console.log('[VR Addon Preset] Received event from manager:', event, data);
        // Forward event to all connected preview clients via EventSource
        // Format: { type: event, payload: data }
        for (const listener of eventListeners) {
          listener(event, data);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[VR Addon Preset] Error handling emit-event:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: String(error) }));
      }
    });
    return;
  }

  // RPC endpoint - proxy JSON-RPC requests to CLI
  if (pathname === '/rpc' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        console.log(
          '[VR Addon] Received RPC request:',
          request.method,
          request.params ? JSON.stringify(request.params).substring(0, 200) : '',
        );

        if (!bridge) {
          console.error('[VR Addon] Bridge not initialized when RPC request received');
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: -32000, message: 'Bridge not initialized' } }));
          return;
        }

        // Forward request to bridge
        // The bridge.request() method will wait for readiness if needed
        try {
          console.log('[VR Addon] Forwarding request to bridge...');
          const result = await bridge.request(request.method, request.params);
          console.log(
            '[VR Addon] Bridge request completed, result:',
            JSON.stringify(result).substring(0, 200),
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id || null,
              result,
            }),
          );
        } catch (error) {
          console.error(
            '[VR Addon] Bridge request failed:',
            error instanceof Error ? error.message : 'Unknown error',
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id || null,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : 'Unknown error',
              },
            }),
          );
        }
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : 'Unknown error',
            },
          }),
        );
      }
    });
    return;
  }

  // Serve image files endpoint
  if (pathname?.startsWith('/image/') && req.method === 'GET') {
    try {
      const imagePath = decodeURIComponent(pathname.substring(7));
      const resultsDir = join(process.cwd(), 'visual-regression');
      const fullPath = join(resultsDir, imagePath);

      // Security check
      if (!fullPath.startsWith(resultsDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied' }));
        return;
      }

      // Check if file exists
      if (!existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      const stats = await stat(fullPath);
      if (!stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }

      // Read the image file
      const imageData = await readFile(fullPath);

      // Determine content type
      const ext = fullPath.toLowerCase().split('.').pop();
      let contentType = 'application/octet-stream';
      if (ext === 'png') contentType = 'image/png';
      else if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
      else if (ext === 'gif') contentType = 'image/gif';
      else if (ext === 'webp') contentType = 'image/webp';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(imageData);
      return;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to serve image' }));
      return;
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
