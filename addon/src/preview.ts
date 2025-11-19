/**
 * Preview-side code for the Visual Regression addon.
 *
 * This runs in the browser and communicates with the Node.js bridge via HTTP.
 */

import { EVENTS } from './constants.js';

// RPC server URL (minimal HTTP server for browser <-> Node.js communication)
const RPC_BASE_URL = 'http://localhost:6007';

// Get Storybook URL from current location
function getStorybookUrl(): string {
  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location;
    // Use the current window location as the Storybook URL
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
  }
  return 'http://localhost:6006'; // Fallback
}

// Get Storybook channel
type Channel = {
  emit: (event: string, data?: unknown) => void;
  on: (event: string, callback: (data?: unknown) => void) => void;
  off: (event: string, callback: (data?: unknown) => void) => void;
};

const getChannel = (): Channel | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  // Try multiple ways to get the channel
  // Method 1: Direct access to window.__STORYBOOK_ADDONS_CHANNEL__
  const windowChannel = (window as unknown as { __STORYBOOK_ADDONS_CHANNEL__?: Channel })
    .__STORYBOOK_ADDONS_CHANNEL__;
  if (windowChannel) {
    return windowChannel;
  }

  // Method 2: Try via addons if available (for newer Storybook versions)
  try {
    const addons = (window as unknown as { __STORYBOOK_ADDONS__?: { getChannel?: () => Channel } })
      .__STORYBOOK_ADDONS__;
    if (addons?.getChannel) {
      return addons.getChannel();
    }
  } catch (error) {
    // Ignore
  }

  return null;
};

// Guard to prevent multiple initializations
declare global {
  interface Window {
    __VISUAL_REGRESSION_INITIALIZED__?: boolean;
  }
}

/**
 * Send JSON-RPC request to Node.js bridge
 */
async function rpcRequest(method: string, params?: any): Promise<any> {
  const RPC_BASE_URL = 'http://localhost:6007';
  console.log(`[VR Addon Preview] Making RPC request: ${method}`, params);
  try {
    const response = await fetch(`${RPC_BASE_URL}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
      }),
    });

    console.log(`[VR Addon Preview] RPC response status: ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[VR Addon Preview] RPC request failed: ${response.status} ${response.statusText}`,
        errorText,
      );
      throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log('[VR Addon Preview] RPC response:', result);
    if (result.error) {
      console.error('[VR Addon Preview] RPC error response:', result.error);
      throw new Error(result.error.message || 'Unknown RPC error');
    }
    return result.result;
  } catch (error) {
    console.error('[VR Addon Preview] RPC request exception:', error);
    throw error;
  }
}

/**
 * Initialize the addon
 */
const initializeAddon = async () => {
  // Prevent multiple initializations
  if (typeof window !== 'undefined' && window.__VISUAL_REGRESSION_INITIALIZED__) {
    console.log('[VR Addon Preview] Already initialized, skipping');
    return;
  }

  console.log('[VR Addon Preview] Initializing addon...');
  const channel = getChannel();
  if (!channel) {
    console.log('[VR Addon Preview] Channel not available yet, retrying...');
    setTimeout(initializeAddon, 100);
    return;
  }

  console.log('[VR Addon Preview] Channel available, setting up event listeners');
  // Mark as initialized
  if (typeof window !== 'undefined') {
    window.__VISUAL_REGRESSION_INITIALIZED__ = true;
  }

  // Load existing failed results from the index
  const loadExistingResults = async () => {
    try {
      const results = await rpcRequest('getResults', {});
      if (Array.isArray(results) && results.length > 0) {
        console.log(`[VR Addon] Loaded ${results.length} failed result(s) from index`);
        // Emit each result as a TEST_RESULT event
        for (const result of results) {
          channel.emit(EVENTS.TEST_RESULT, {
            storyId: result.storyId,
            storyName: result.storyName || result.storyId,
            status: result.status,
            diffPath: result.diffPath,
            actualPath: result.actualPath,
            expectedPath: result.expectedPath,
            errorPath: result.errorPath,
            errorType: result.errorType,
            error: result.error,
            diffPixels: result.diffPixels,
            diffPercent: result.diffPercent,
          });
        }
      } else {
        console.log('[VR Addon] No failed results found in index');
      }
    } catch (error) {
      // Silently fail - results index might not exist yet or bridge not ready
      console.log('[VR Addon] Could not load existing results:', error);
    }
  };

  // Load results after bridge is ready (the ready event will be received via EventSource)
  // We'll trigger loading after the EventSource connects
  let resultsLoaded = false;
  const tryLoadResults = () => {
    if (!resultsLoaded) {
      resultsLoaded = true;
      // Wait a bit for bridge to be fully ready, then load results
      setTimeout(loadExistingResults, 500);
    }
  };

  // Handler for RUN_TEST event
  const handleRunTest = async (data: unknown) => {
    console.log('[VR Addon Preview] RUN_TEST event received:', data);
    const eventData = data as { storyId?: string };
    const storyId = eventData.storyId;
    if (!storyId) {
      console.log('[VR Addon Preview] No storyId provided');
      channel.emit(EVENTS.TEST_COMPLETE);
      return;
    }

    console.log(`[VR Addon Preview] Starting test for story: ${storyId}`);
    console.log('[VR Addon Preview] Emitting TEST_STARTED event');
    channel.emit(EVENTS.TEST_STARTED);
    console.log('[VR Addon Preview] TEST_STARTED event emitted');

    // Also send via HTTP to ensure manager receives it
    try {
      await fetch('http://localhost:6007/emit-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: EVENTS.TEST_STARTED, data: {} }),
      });
      console.log('[VR Addon Preview] TEST_STARTED sent via HTTP');
    } catch (err) {
      console.error('[VR Addon Preview] Error sending TEST_STARTED via HTTP:', err);
    }

    try {
      const storybookUrl = getStorybookUrl();
      console.log(
        `[VR Addon Preview] Sending RPC request with URL: ${storybookUrl}, grep: ^${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      );
      await rpcRequest('run', {
        url: storybookUrl,
        grep: `^${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      });
      console.log('[VR Addon Preview] RPC request completed');

      // After test completes, reload all results to get the latest state
      // Wait a bit for the index to be updated
      setTimeout(async () => {
        console.log('[VR Addon] Reloading results after test run...');
        await loadExistingResults();
      }, 500);

      channel.emit(EVENTS.TEST_COMPLETE);
    } catch (error) {
      console.error('[VR Addon Preview] RPC request failed:', error);
      channel.emit(
        EVENTS.LOG_OUTPUT,
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      channel.emit(EVENTS.TEST_COMPLETE);

      // Still try to reload results even if there was an error
      setTimeout(async () => {
        await loadExistingResults();
      }, 500);
    }
  };

  // Listen for test requests from the manager
  console.log(`[VR Addon Preview] Registering listener for ${EVENTS.RUN_TEST}`, {
    channel: !!channel,
    channelType: channel ? typeof channel : 'null',
    hasOn: channel ? typeof (channel as any).on : 'null',
  });

  channel.on(EVENTS.RUN_TEST, handleRunTest);

  // Listen for "run all tests" requests
  channel.on(EVENTS.RUN_ALL_TESTS, async () => {
    channel.emit(EVENTS.TEST_STARTED);

    try {
      await rpcRequest('run', {
        url: getStorybookUrl(),
      });

      // After all tests complete, reload all results
      setTimeout(async () => {
        console.log('[VR Addon] Reloading results after all tests run...');
        await loadExistingResults();
      }, 500);

      channel.emit(EVENTS.TEST_COMPLETE);
    } catch (error) {
      channel.emit(
        EVENTS.LOG_OUTPUT,
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      channel.emit(EVENTS.TEST_COMPLETE);

      // Still try to reload results even if there was an error
      setTimeout(async () => {
        await loadExistingResults();
      }, 500);
    }
  });

  // Listen for "run failed tests" requests
  channel.on(EVENTS.RUN_FAILED_TESTS, async () => {
    channel.emit(EVENTS.TEST_STARTED);

    try {
      await rpcRequest('run', {
        url: getStorybookUrl(),
        failedOnly: true,
      });

      // After failed tests complete, reload all results
      setTimeout(async () => {
        console.log('[VR Addon] Reloading results after failed tests run...');
        await loadExistingResults();
      }, 500);

      channel.emit(EVENTS.TEST_COMPLETE);
    } catch (error) {
      channel.emit(
        EVENTS.LOG_OUTPUT,
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      channel.emit(EVENTS.TEST_COMPLETE);

      // Still try to reload results even if there was an error
      setTimeout(async () => {
        await loadExistingResults();
      }, 500);
    }
  });

  // Handler for UPDATE_BASELINE event
  const handleUpdateBaseline = async (data: unknown) => {
    console.log('[VR Addon Preview] UPDATE_BASELINE event received:', data);
    const eventData = data as { storyId?: string };
    const storyId = eventData.storyId;
    if (!storyId) {
      console.log('[VR Addon Preview] No storyId provided for UPDATE_BASELINE');
      channel.emit(EVENTS.TEST_COMPLETE);
      return;
    }

    channel.emit(EVENTS.UPDATE_STARTED);

    try {
      await rpcRequest('run', {
        url: getStorybookUrl(),
        update: true,
        grep: `^${storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      });

      // After update completes, reload results to reflect the updated state
      // Wait a bit for the index to be updated
      setTimeout(async () => {
        console.log('[VR Addon] Reloading results after snapshot update...');
        await loadExistingResults();
      }, 500);

      channel.emit(EVENTS.TEST_COMPLETE);
    } catch (error) {
      channel.emit(
        EVENTS.LOG_OUTPUT,
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      channel.emit(EVENTS.TEST_COMPLETE);

      // Still try to reload results even if there was an error
      setTimeout(async () => {
        await loadExistingResults();
      }, 500);
    }
  };

  // Listen for baseline update requests
  console.log(`[VR Addon Preview] Registering listener for ${EVENTS.UPDATE_BASELINE}`);
  channel.on(EVENTS.UPDATE_BASELINE, handleUpdateBaseline);

  // Listen for create missing snapshots requests
  channel.on(EVENTS.CREATE_MISSING_SNAPSHOTS, async () => {
    channel.emit(EVENTS.UPDATE_STARTED);

    try {
      await rpcRequest('run', {
        url: getStorybookUrl(),
        update: true,
        missingOnly: true,
      });

      // After update completes, reload results to reflect the updated state
      // Wait a bit for the index to be updated
      setTimeout(async () => {
        console.log('[VR Addon] Reloading results after creating missing snapshots...');
        await loadExistingResults();
      }, 500);

      channel.emit(EVENTS.TEST_COMPLETE);
    } catch (error) {
      channel.emit(
        EVENTS.LOG_OUTPUT,
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      channel.emit(EVENTS.TEST_COMPLETE);

      // Still try to reload results even if there was an error
      setTimeout(async () => {
        await loadExistingResults();
      }, 500);
    }
  });

  // Listen for cancel requests
  channel.on(EVENTS.CANCEL_TEST, async () => {
    try {
      await rpcRequest('cancel');
      // Emit test complete after cancel
      channel.emit(EVENTS.TEST_COMPLETE);
    } catch (error) {
      // Ignore cancel errors, but still emit complete
      channel.emit(EVENTS.TEST_COMPLETE);
    }
  });

  // Poll for events from the bridge
  // The bridge will emit events via HTTP SSE or we can poll
  // For now, we'll set up an EventSource connection
  let eventSource: EventSource | null = null;

  const connectEventSource = () => {
    try {
      console.log('[VR Addon Preview] Connecting to EventSource:', `${RPC_BASE_URL}/events`);
      eventSource = new EventSource(`${RPC_BASE_URL}/events`);

      eventSource.onopen = () => {
        console.log('[VR Addon Preview] EventSource connected');
      };

      eventSource.onerror = (error) => {
        console.error('[VR Addon Preview] EventSource error:', error);
      };

      eventSource.onmessage = (event) => {
        try {
          console.log('[VR Addon Preview] EventSource message received:', event.data);
          const data = JSON.parse(event.data);
          const { type, payload } = data;
          console.log('[VR Addon Preview] Parsed EventSource data:', { type, payload });

          switch (type) {
            case 'connected':
              // EventSource connected, try to load results
              tryLoadResults();
              break;
            case 'ready':
              // Bridge is ready, load results
              tryLoadResults();
              break;
            case EVENTS.RUN_TEST:
              // Forward RUN_TEST event from manager via HTTP
              console.log('[VR Addon Preview] Received RUN_TEST via EventSource:', payload);
              // Call the handler directly with the payload (which contains { storyId })
              handleRunTest(payload);
              break;
            case EVENTS.UPDATE_BASELINE:
              // Forward UPDATE_BASELINE event from manager via HTTP
              console.log('[VR Addon Preview] Received UPDATE_BASELINE via EventSource:', payload);
              // Call the handler directly
              handleUpdateBaseline(payload);
              break;
            case EVENTS.UPDATE_STARTED:
              // Forward UPDATE_STARTED event from preview to manager
              console.log(
                '[VR Addon Preview] Received UPDATE_STARTED via EventSource (forwarding to manager)',
              );
              if (channel) {
                channel.emit(EVENTS.UPDATE_STARTED);
              }
              break;
            case EVENTS.TEST_STARTED:
              // Forward TEST_STARTED event from preview to manager
              console.log(
                '[VR Addon Preview] Received TEST_STARTED via EventSource (forwarding to manager)',
              );
              if (channel) {
                channel.emit(EVENTS.TEST_STARTED);
              }
              break;
            case 'progress':
              // Emit progress event with full progress info
              channel.emit(EVENTS.PROGRESS, payload);
              break;
            case 'storyStart':
              channel.emit(EVENTS.LOG_OUTPUT, `Starting: ${payload.storyName || payload.storyId}`);
              break;
            case 'storyComplete':
              const status =
                payload.status === 'passed' ? '✓' : payload.status === 'failed' ? '✗' : '○';
              channel.emit(EVENTS.LOG_OUTPUT, `${status} ${payload.storyName || payload.storyId}`);
              channel.emit(EVENTS.TEST_RESULT, {
                storyId: payload.storyId,
                storyName: payload.storyName,
                status: payload.status,
                diffPath: payload.diffPath,
                actualPath: payload.actualPath,
                expectedPath: payload.expectedPath,
                errorPath: payload.errorPath,
                errorType: payload.errorType,
                error: payload.error,
                diffPixels: payload.diffPixels,
                diffPercent: payload.diffPercent,
              });
              break;
            case 'log':
              if (payload?.message) {
                channel.emit(EVENTS.LOG_OUTPUT, payload.message);
              }
              break;
            case 'complete':
              channel.emit(EVENTS.TEST_COMPLETE);
              break;
            case 'error':
              channel.emit(EVENTS.LOG_OUTPUT, `Error: ${payload?.message || 'Unknown error'}`);
              channel.emit(EVENTS.TEST_COMPLETE);
              break;
          }
        } catch (error) {
          // Ignore parse errors
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        // Retry connection
        setTimeout(connectEventSource, 2000);
      };
    } catch (error) {
      // Retry connection
      setTimeout(connectEventSource, 2000);
    }
  };

  connectEventSource();
};

// Initialize when ready
if (typeof window !== 'undefined') {
  initializeAddon();
}
