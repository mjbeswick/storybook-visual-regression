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

// Get port from environment variable or use default
const getServerPort = () => {
  const port = process.env.VR_ADDON_PORT || process.env.STORYBOOK_VISUAL_REGRESSION_PORT;
  return port ? parseInt(port, 10) : 6007;
};

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
  console.log('[VR Addon Preset] previewAnnotations called', { hasServer: !!server, options });
  
  // Start bridge and HTTP server (only once)
  if (!server) {
    try {
      console.log('[VR Addon Preset] Initializing server and bridge...');
      const defaultConfig = loadAddonConfig();
      const cliCommand = options.cliCommand || defaultConfig.cliCommand;
      console.log('[VR Addon Preset] CLI command:', cliCommand);

      // Create bridge with the CLI command
      bridge = getJsonRpcBridge(cliCommand);

      // Start bridge (this will spawn CLI)
      bridge.start(eventChannel as any).catch((error) => {
        console.error('[VR Addon Preset] Failed to start bridge:', error);
      });

      // Log when bridge is ready (for debugging)
      // Note: We don't wait for bridge to be ready here because it's async
      // The request handler will wait for readiness

      // Create minimal HTTP server for browser <-> Node.js communication
      const port = getServerPort();
      console.log('[VR Addon Preset] Creating HTTP server on port', port);
      
      try {
        server = createServer(handleRequest);
        
        server.listen(port, '127.0.0.1', () => {
          console.log(`[VR Addon Preset] RPC server listening on port ${port}`);
        }).on('error', (error: any) => {
          console.error('[VR Addon Preset] Server error:', error);
          if (error.code === 'EADDRINUSE') {
            console.error(`[VR Addon Preset] Port ${port} is already in use. Please set VR_ADDON_PORT environment variable to use a different port.`);
          } else {
            console.error('[VR Addon Preset] Failed to start server:', error);
          }
          server = null; // Reset so it can be retried
        });
      } catch (error) {
        console.error('[VR Addon Preset] Error creating server:', error);
        server = null;
      }

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
      try {
        // Check if response is still writable
        if (res.writableEnded || res.destroyed || res.closed) {
          console.log('[VR Addon Preset] Response ended/destroyed/closed, removing listener');
          eventListeners.delete(listener);
          return;
        }
        
        // Check if request is still active
        if (req.destroyed || req.closed) {
          console.log('[VR Addon Preset] Request destroyed/closed, removing listener');
          eventListeners.delete(listener);
          return;
        }
        
        // Try to write - catch any errors
        try {
          const message = `data: ${JSON.stringify({ type, payload })}\n\n`;
          const written = res.write(message);
          if (!written) {
            console.log('[VR Addon Preset] Write returned false (backpressure), but continuing');
          }
        } catch (writeError) {
          console.error('[VR Addon Preset] Error writing to EventSource:', writeError);
          eventListeners.delete(listener);
        }
      } catch (error) {
        console.error('[VR Addon Preset] Error in listener:', error);
        eventListeners.delete(listener);
      }
    };

    eventListeners.add(listener);

    // Send periodic keep-alive messages to prevent connection timeout
    // Use shorter interval to keep connection alive more aggressively
    const keepAliveInterval = setInterval(() => {
      try {
        if (res.writableEnded || res.destroyed || res.closed || req.destroyed || req.closed) {
          console.log('[VR Addon Preset] Connection closed, clearing keep-alive interval');
          clearInterval(keepAliveInterval);
          eventListeners.delete(listener);
          return;
        }
        res.write(`: keepalive\n\n`);
      } catch (error) {
        console.error('[VR Addon Preset] Error sending keep-alive:', error);
        clearInterval(keepAliveInterval);
        eventListeners.delete(listener);
      }
    }, 5000); // Every 5 seconds (very frequent to keep connection alive)

    req.on('close', () => {
      console.log('[VR Addon Preset] EventSource client disconnected (close event)');
      clearInterval(keepAliveInterval);
      eventListeners.delete(listener);
      console.log(`[VR Addon Preset] Remaining EventSource connections: ${eventListeners.size}`);
    });

    req.on('error', (error) => {
      // Don't log ECONNRESET as error - it's expected when browser closes connection
      const errorCode = (error as any).code;
      if (errorCode === 'ECONNRESET') {
        console.log('[VR Addon Preset] EventSource connection reset by client (ECONNRESET) - this is normal');
      } else {
        console.error('[VR Addon Preset] EventSource request error:', error);
        console.error('[VR Addon Preset] Error details:', {
          code: errorCode,
          message: (error as any).message,
          stack: (error as any).stack,
        });
      }
      clearInterval(keepAliveInterval);
      eventListeners.delete(listener);
      console.log(`[VR Addon Preset] Remaining EventSource connections: ${eventListeners.size}`);
    });
    
    // Also listen for response close/error
    res.on('close', () => {
      console.log('[VR Addon Preset] EventSource response closed');
      clearInterval(keepAliveInterval);
      eventListeners.delete(listener);
      console.log(`[VR Addon Preset] Remaining EventSource connections: ${eventListeners.size}`);
    });
    
    res.on('error', (error) => {
      console.error('[VR Addon Preset] EventSource response error:', error);
      clearInterval(keepAliveInterval);
      eventListeners.delete(listener);
      console.log(`[VR Addon Preset] Remaining EventSource connections: ${eventListeners.size}`);
    });
    
    // Prevent the connection from being closed by setting socket timeout to 0 (no timeout)
    if (req.socket) {
      req.socket.setTimeout(0);
      req.socket.setKeepAlive(true, 60000); // Keep alive every 60 seconds
    }

    // Send initial connection message
    try {
      const connectedMessage = JSON.stringify({ type: 'connected' });
      res.write(`data: ${connectedMessage}\n\n`);
      console.log('[VR Addon Preset] EventSource client connected, sent:', connectedMessage);
    } catch (error) {
      console.error('[VR Addon Preset] Error sending initial connection message:', error);
      clearInterval(keepAliveInterval);
      eventListeners.delete(listener);
    }
    
    // Store response and request references for debugging and connection checking
    (listener as any).response = res;
    (listener as any).request = req;
    (listener as any).connectedAt = Date.now();

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
        console.log(`[VR Addon Preset] Forwarding to ${eventListeners.size} EventSource client(s)`);
        
        // Forward event to all connected preview clients via EventSource
        // Format: { type: event, payload: data }
        let forwardedCount = 0;
        let errorCount = 0;
        const eventMessage = JSON.stringify({ type: event, payload: data });
        console.log(`[VR Addon Preset] Sending event message: ${eventMessage.substring(0, 200)}`);
        
        // If no listeners, log a warning but still return success
        // The channel event should work as a fallback
        if (eventListeners.size === 0) {
          console.warn('[VR Addon Preset] No EventSource listeners available, event will be lost unless channel works');
        }
        
        // Create a copy of the set to iterate over, as we might modify it
        const listenersToTry = Array.from(eventListeners);
        
        for (const listener of listenersToTry) {
          try {
            const res = (listener as any).response;
            const req = (listener as any).request;
            const connectionAge = Date.now() - ((listener as any).connectedAt || 0);

            if (!res) {
              console.log('[VR Addon Preset] Listener has no response object, removing');
              eventListeners.delete(listener);
              errorCount++;
              continue;
            }
            
            // Check if response is writable and not destroyed
            if (res.writableEnded || res.destroyed || res.closed) {
              console.log('[VR Addon Preset] Listener response is closed (writableEnded:', res.writableEnded, 'destroyed:', res.destroyed, 'closed:', res.closed, '), removing listener');
              eventListeners.delete(listener);
              errorCount++;
              continue;
            }
            
            // Check if request is still active
            if (req && (req.destroyed || req.closed)) {
              console.log('[VR Addon Preset] Listener request is destroyed/closed, removing listener');
              eventListeners.delete(listener);
              errorCount++;
              continue;
            }

            // Debug: Log connection age for troubleshooting
            console.log(`[VR Addon Preset] Checking listener age: ${connectionAge}ms old`);

            // Try to write - if it fails, the connection is likely closed
            try {
              listener(event, data);
              forwardedCount++;
              console.log(`[VR Addon Preset] Event forwarded to listener (connected ${Date.now() - ((listener as any).connectedAt || 0)}ms ago)`);
            } catch (writeError) {
              console.error('[VR Addon Preset] Error writing to listener:', writeError);
              eventListeners.delete(listener);
              errorCount++;
            }
          } catch (error) {
            console.error('[VR Addon Preset] Error forwarding event to listener:', error);
            errorCount++;
            // Remove the listener if it errors (connection might be closed)
            eventListeners.delete(listener);
          }
        }
        console.log(`[VR Addon Preset] Event forwarded: ${forwardedCount} success, ${errorCount} errors`);
        console.log(`[VR Addon Preset] Active EventSource connections: ${eventListeners.size}`);

        // If no EventSource clients received the event, log a warning
        // The channel should still work as fallback
        if (forwardedCount === 0) {
          console.warn('[VR Addon Preset] No active EventSource connections received the event - channel fallback should work');
        }

        // Always return success - the channel event should work as fallback
        // Even if EventSource fails, the channel should deliver the event
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, forwarded: forwardedCount, errors: errorCount, channelFallback: true }));
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
